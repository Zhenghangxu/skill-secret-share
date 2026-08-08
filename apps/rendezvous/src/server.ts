import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ClientRendezvousMessage,
  IceServerConfig,
  ServerRendezvousMessage,
} from '@skillspore/protocol';

const WAITING_TTL_MS = 10 * 60 * 1000;
const CONNECTED_TTL_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const SIGNALING_LIMIT_BYTES = 64 * 1024;
const port = Number.parseInt(process.env.PORT ?? '8787', 10);

interface Session {
  nameplate: string;
  sid: string;
  sender: WebSocket;
  receiver: WebSocket | undefined;
  iceServers: IceServerConfig[];
  expiresAt: number;
  failedAttempts: number;
}

interface SocketContext {
  ip: string;
  session?: Session;
  role?: 'sender' | 'receiver';
}

interface RateBucket {
  startedAt: number;
  count: number;
}

const sessions = new Map<string, Session>();
const contexts = new WeakMap<WebSocket, SocketContext>();
const rateBuckets = new Map<string, RateBucket>();
const metrics = {
  sessionsCreated: 0,
  sessionsJoined: 0,
  sessionsCompleted: 0,
  failedAttempts: 0,
  rejectedRequests: 0,
};

function send(socket: WebSocket, message: ServerRendezvousMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function reject(socket: WebSocket, code: string, message: string): void {
  metrics.rejectedRequests++;
  send(socket, { type: 'error', code, message });
}

function allowRate(ip: string, kind: 'create' | 'join'): boolean {
  const windowMs = 60 * 60 * 1000;
  const limit = kind === 'create' ? 20 : 60;
  const key = `${ip}:${kind}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

function allocateNameplate(): string {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const nameplate = randomInt(0, 10_000).toString().padStart(4, '0');
    if (!sessions.has(nameplate)) return nameplate;
  }
  throw new Error('No rendezvous nameplates are available');
}

async function getIceServers(): Promise<IceServerConfig[]> {
  const configured = process.env.SKILLSPORE_ICE_SERVERS_JSON;
  if (configured) return JSON.parse(configured) as IceServerConfig[];

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Tokens.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Ttl: '900' }),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!response.ok) throw new Error(`TURN credential provider returned HTTP ${response.status}`);
  const data = (await response.json()) as {
    ice_servers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  };
  if (!data.ice_servers || data.ice_servers.length === 0) {
    throw new Error('TURN credential provider returned no ICE servers');
  }
  return data.ice_servers;
}

function deleteSession(session: Session): void {
  if (sessions.get(session.nameplate) === session) sessions.delete(session.nameplate);
}

async function handleCreate(socket: WebSocket, context: SocketContext): Promise<void> {
  if (context.session)
    return reject(socket, 'already-in-session', 'Connection already has a session');
  if (!allowRate(context.ip, 'create'))
    return reject(socket, 'rate-limited', 'Too many sessions created');
  try {
    const nameplate = allocateNameplate();
    const sid = randomBytes(32).toString('base64url');
    const iceServers = await getIceServers();
    const session: Session = {
      nameplate,
      sid,
      sender: socket,
      receiver: undefined,
      iceServers,
      expiresAt: Date.now() + WAITING_TTL_MS,
      failedAttempts: 0,
    };
    sessions.set(nameplate, session);
    context.session = session;
    context.role = 'sender';
    metrics.sessionsCreated++;
    send(socket, {
      type: 'created',
      nameplate,
      sid,
      expiresAt: new Date(session.expiresAt).toISOString(),
      iceServers,
    });
  } catch {
    reject(socket, 'service-unavailable', 'Unable to create a session');
  }
}

function handleJoin(socket: WebSocket, context: SocketContext, nameplate: string): void {
  if (context.session)
    return reject(socket, 'already-in-session', 'Connection already has a session');
  if (!allowRate(context.ip, 'join'))
    return reject(socket, 'rate-limited', 'Too many join attempts');
  if (!/^\d{4}$/.test(nameplate))
    return reject(socket, 'invalid-nameplate', 'Nameplate must contain four digits');
  const session = sessions.get(nameplate);
  if (!session || session.expiresAt <= Date.now())
    return reject(socket, 'not-found', 'Session is unavailable');
  if (session.receiver) return reject(socket, 'occupied', 'A receiver is already connected');
  session.receiver = socket;
  session.expiresAt = Date.now() + CONNECTED_TTL_MS;
  context.session = session;
  context.role = 'receiver';
  metrics.sessionsJoined++;
  send(socket, {
    type: 'joined',
    nameplate,
    sid: session.sid,
    expiresAt: new Date(session.expiresAt).toISOString(),
    iceServers: session.iceServers,
  });
  send(session.sender, { type: 'paired' });
  send(socket, { type: 'paired' });
}

function handleRelay(socket: WebSocket, context: SocketContext, payload: unknown): void {
  const session = context.session;
  if (!session || !session.receiver) return reject(socket, 'not-paired', 'No peer is connected');
  const encoded = JSON.stringify(payload);
  if (encoded === undefined) return reject(socket, 'invalid-message', 'Relay payload is required');
  if (Buffer.byteLength(encoded) > SIGNALING_LIMIT_BYTES) {
    return reject(socket, 'message-too-large', 'Signaling message exceeds 64 KiB');
  }
  const peer = context.role === 'sender' ? session.receiver : session.sender;
  send(peer, { type: 'relay', payload });
}

function handleAttemptFailed(socket: WebSocket, context: SocketContext): void {
  const session = context.session;
  if (!session || context.role !== 'sender')
    return reject(socket, 'forbidden', 'Only the sender can fail an attempt');
  session.failedAttempts++;
  metrics.failedAttempts++;
  if (session.receiver) {
    reject(session.receiver, 'authentication-failed', 'Peer authentication failed');
    session.receiver.close(4001, 'authentication failed');
    session.receiver = undefined;
  }
  if (session.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    reject(session.sender, 'attempt-limit', 'Session invalidated after repeated failures');
    session.sender.close(4002, 'attempt limit');
    deleteSession(session);
  }
}

function handleComplete(context: SocketContext): void {
  const session = context.session;
  if (!session) return;
  metrics.sessionsCompleted++;
  deleteSession(session);
  session.sender.close(1000, 'complete');
  session.receiver?.close(1000, 'complete');
}

async function handleMessage(socket: WebSocket, raw: Buffer): Promise<void> {
  const context = contexts.get(socket)!;
  let message: ClientRendezvousMessage;
  try {
    message = JSON.parse(raw.toString('utf8')) as ClientRendezvousMessage;
  } catch {
    return reject(socket, 'invalid-json', 'Message must be valid JSON');
  }
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    return reject(socket, 'invalid-message', 'Message must be an object with a type');
  }
  switch (message.type) {
    case 'create':
      await handleCreate(socket, context);
      break;
    case 'join':
      handleJoin(socket, context, message.nameplate);
      break;
    case 'relay':
      handleRelay(socket, context, message.payload);
      break;
    case 'attempt-failed':
      handleAttemptFailed(socket, context);
      break;
    case 'complete':
      handleComplete(context);
      break;
    default:
      reject(socket, 'invalid-message', 'Unknown message type');
  }
}

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.url === '/metrics') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ...metrics, activeSessions: sessions.size }));
    return;
  }
  response.writeHead(404).end();
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: SIGNALING_LIMIT_BYTES });
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/v1/rendezvous') {
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    const forwarded = request.headers['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim() ||
      request.socket.remoteAddress ||
      'unknown';
    contexts.set(webSocket, { ip });
    webSocket.on(
      'message',
      (data) => void handleMessage(webSocket, Buffer.from(data as ArrayBuffer))
    );
    webSocket.on('close', () => {
      const context = contexts.get(webSocket);
      const session = context?.session;
      if (!session) return;
      if (context.role === 'sender') {
        deleteSession(session);
        if (session.receiver) send(session.receiver, { type: 'peer-left' });
      } else if (session.receiver === webSocket) {
        session.receiver = undefined;
        send(session.sender, { type: 'peer-left' });
      }
    });
  });
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.expiresAt > now) continue;
    send(session.sender, { type: 'error', code: 'expired', message: 'Session expired' });
    if (session.receiver)
      send(session.receiver, { type: 'error', code: 'expired', message: 'Session expired' });
    session.sender.close(4003, 'expired');
    session.receiver?.close(4003, 'expired');
    deleteSession(session);
  }
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.startedAt >= 60 * 60 * 1000) rateBuckets.delete(key);
  }
}, 30_000);
cleanupTimer.unref();

server.listen(port, '0.0.0.0', () => {
  console.log(`SkillSpore rendezvous listening on port ${port}`);
});

function shutdown(): void {
  clearInterval(cleanupTimer);
  for (const session of sessions.values()) {
    session.sender.close(1012, 'service restart');
    session.receiver?.close(1012, 'service restart');
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

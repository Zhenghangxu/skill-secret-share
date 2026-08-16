import { randomBytes, randomInt } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  RENDEZVOUS_PATH,
  SIGNALING_LIMIT_BYTES,
  parseClientRendezvousJson,
  parseIceServerConfig,
  parseRendezvousSubprotocol,
  type ClientRendezvousMessage,
  type IceServerConfig,
  type RendezvousRole,
  type ServerRendezvousMessage,
} from '@skillspore/protocol';
import WebSocket, { WebSocketServer } from 'ws';

const WAITING_TTL_MS = 10 * 60 * 1000;
const CONNECTED_TTL_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const MAX_NAMEPLATE_ATTEMPTS = 20;
const MAX_INVALID_MESSAGES = 5;
const MAX_SESSION_MESSAGES = 200;
const SIGNALING_RATE_PER_SECOND = 20;
const SIGNALING_BURST = 50;
const port = Number.parseInt(process.env.PORT ?? '8787', 10);

interface Session {
  nameplate: string;
  sid: string;
  sender: WebSocket;
  receiver: WebSocket | undefined;
  receiverReserved: boolean;
  expiresAt: number;
  failedAttempts: number;
  lifetimeMessages: number;
  rateTokens: number;
  rateUpdatedAt: number;
  completed: boolean;
}

interface SocketContext {
  session: Session;
  role: RendezvousRole;
  invalidMessages: number;
}

interface RateBucket {
  startedAt: number;
  count: number;
}

type RateKind = 'upgrade' | 'create' | 'join';

const sessions = new Map<string, Session>();
const contexts = new WeakMap<WebSocket, SocketContext>();
const rateBuckets = new Map<string, RateBucket>();
const metrics = {
  sessionsCreated: 0,
  sessionsJoined: 0,
  sessionsCompleted: 0,
  failedAttempts: 0,
  rejectedUpgrades: 0,
  invalidMessages: 0,
  abuseClosures: 0,
  providerErrors: 0,
};

function send(socket: WebSocket, message: ServerRendezvousMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, code: string, message: string, retryAfterMs?: number): void {
  send(socket, {
    type: 'error',
    code,
    message,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  metrics.rejectedUpgrades++;
  const names: Record<number, string> = {
    400: 'Bad Request',
    404: 'Not Found',
    409: 'Conflict',
    429: 'Too Many Requests',
    503: 'Service Unavailable',
  };
  const body = `${message}\n`;
  socket.write(
    [
      `HTTP/1.1 ${status} ${names[status] ?? 'Error'}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      body,
    ].join('\r\n')
  );
  socket.destroy();
}

function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  return (
    (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim() ||
    request.socket.remoteAddress ||
    'unknown'
  );
}

function allowRate(ip: string, kind: RateKind): boolean {
  const limits: Record<RateKind, number> = { upgrade: 120, create: 20, join: 60 };
  const windowMs = 60_000;
  const key = `${ip}:${kind}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (bucket.count >= limits[kind]) return false;
  bucket.count++;
  return true;
}

function allocateSession(): Session | undefined {
  for (let attempt = 0; attempt < MAX_NAMEPLATE_ATTEMPTS; attempt++) {
    const nameplate = randomInt(0, 10_000).toString().padStart(4, '0');
    if (sessions.has(nameplate)) continue;
    const now = Date.now();
    return {
      nameplate,
      sid: randomBytes(32).toString('base64url'),
      sender: undefined as unknown as WebSocket,
      receiver: undefined,
      receiverReserved: false,
      expiresAt: now + WAITING_TTL_MS,
      failedAttempts: 0,
      lifetimeMessages: 0,
      rateTokens: SIGNALING_BURST,
      rateUpdatedAt: now,
      completed: false,
    };
  }
  return undefined;
}

async function getIceServers(): Promise<IceServerConfig[]> {
  const configured = process.env.SKILLSPORE_ICE_SERVERS_JSON;
  if (configured) {
    const parsed = JSON.parse(configured) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Configured ICE servers must be an array');
    return parsed.map(parseIceServerConfig);
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return [{ urls: 'stun:stun.cloudflare.com:3478' }];

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Tokens.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Ttl: '1200' }),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!response.ok) throw new Error(`TURN credential provider returned HTTP ${response.status}`);
  const data = (await response.json()) as { ice_servers?: unknown[] };
  if (!data.ice_servers || data.ice_servers.length === 0) {
    throw new Error('TURN credential provider returned no ICE servers');
  }
  return data.ice_servers.map(parseIceServerConfig);
}

function deleteSession(session: Session): void {
  if (sessions.get(session.nameplate) === session) sessions.delete(session.nameplate);
}

function closeSession(session: Session, code: number, reason: string): void {
  deleteSession(session);
  session.sender.close(code, reason);
  session.receiver?.close(code, reason);
}

async function pairSession(session: Session): Promise<void> {
  const receiver = session.receiver;
  if (!receiver) return;
  let senderIce: IceServerConfig[];
  let receiverIce: IceServerConfig[];
  try {
    [senderIce, receiverIce] = await Promise.all([getIceServers(), getIceServers()]);
  } catch {
    metrics.providerErrors++;
    senderIce = [{ urls: 'stun:stun.cloudflare.com:3478' }];
    receiverIce = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  }
  if (sessions.get(session.nameplate) !== session || session.receiver !== receiver) return;
  send(session.sender, { type: 'paired', iceServers: senderIce });
  send(receiver, { type: 'paired', iceServers: receiverIce });
}

function consumeSignal(session: Session): boolean {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, now - session.rateUpdatedAt) / 1000;
  session.rateTokens = Math.min(
    SIGNALING_BURST,
    session.rateTokens + elapsedSeconds * SIGNALING_RATE_PER_SECOND
  );
  session.rateUpdatedAt = now;
  if (session.rateTokens < 1 || session.lifetimeMessages >= MAX_SESSION_MESSAGES) return false;
  session.rateTokens--;
  session.lifetimeMessages++;
  return true;
}

function invalidMessage(socket: WebSocket, context: SocketContext, message: string): void {
  metrics.invalidMessages++;
  context.invalidMessages++;
  sendError(socket, 'invalid-message', message);
  if (context.invalidMessages >= MAX_INVALID_MESSAGES) {
    metrics.abuseClosures++;
    socket.close(1008, 'too many invalid messages');
  }
}

function handleMessage(socket: WebSocket, raw: WebSocket.RawData, isBinary: boolean): void {
  const context = contexts.get(socket);
  if (!context) return;
  if (isBinary)
    return invalidMessage(socket, context, 'Binary rendezvous messages are not allowed');
  if (!consumeSignal(context.session)) {
    metrics.abuseClosures++;
    socket.close(1008, 'signaling limit exceeded');
    return;
  }

  let message: ClientRendezvousMessage;
  try {
    message = parseClientRendezvousJson(raw.toString());
  } catch (error) {
    return invalidMessage(
      socket,
      context,
      error instanceof Error ? error.message : 'Rendezvous message is invalid'
    );
  }

  const session = context.session;
  switch (message.type) {
    case 'relay': {
      if (!session.receiver) return sendError(socket, 'not-paired', 'No peer is connected');
      const peer = context.role === 'sender' ? session.receiver : session.sender;
      send(peer, { type: 'relay', payload: message.payload });
      break;
    }
    case 'attempt-failed':
      if (context.role !== 'sender') {
        invalidMessage(socket, context, 'Only the sender can fail an attempt');
        break;
      }
      session.failedAttempts++;
      metrics.failedAttempts++;
      if (session.receiver) {
        sendError(session.receiver, 'authentication-failed', 'Peer authentication failed');
        session.receiver.close(4001, 'authentication failed');
        session.receiver = undefined;
        session.receiverReserved = false;
      }
      if (session.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        sendError(session.sender, 'attempt-limit', 'Session invalidated after repeated failures');
        closeSession(session, 4002, 'attempt limit');
      }
      break;
    case 'complete':
      if (session.completed) break;
      session.completed = true;
      metrics.sessionsCompleted++;
      closeSession(session, 1000, 'complete');
      break;
  }
}

function attachSocket(socket: WebSocket, session: Session, role: RendezvousRole): void {
  contexts.set(socket, { session, role, invalidMessages: 0 });
  socket.on('message', (data, isBinary) => handleMessage(socket, data, isBinary));
  socket.on('close', () => {
    const context = contexts.get(socket);
    if (!context || session.completed) return;
    if (context.role === 'sender') {
      deleteSession(session);
      if (session.receiver) send(session.receiver, { type: 'peer-left' });
      session.receiver?.close(1000, 'peer left');
    } else if (session.receiver === socket) {
      session.receiver = undefined;
      session.receiverReserved = false;
      send(session.sender, { type: 'peer-left' });
    }
  });
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

const webSockets = new WebSocketServer({
  noServer: true,
  maxPayload: SIGNALING_LIMIT_BYTES,
  handleProtocols: (protocols) => protocols.values().next().value ?? false,
});

server.on('upgrade', (request, socket, head) => {
  if (request.url !== RENDEZVOUS_PATH) return rejectUpgrade(socket, 404, 'Not found');
  if ((request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    return rejectUpgrade(socket, 400, 'WebSocket upgrade required');
  }

  let selected: ReturnType<typeof parseRendezvousSubprotocol>;
  try {
    const header = request.headers['sec-websocket-protocol'];
    selected = parseRendezvousSubprotocol(Array.isArray(header) ? header.join(',') : header);
  } catch (error) {
    return rejectUpgrade(
      socket,
      400,
      error instanceof Error ? error.message : 'Invalid subprotocol'
    );
  }

  if (process.env.SESSIONS_MODE === 'disabled') {
    return rejectUpgrade(socket, 503, 'New sessions are disabled', { 'Retry-After': '60' });
  }
  const ip = clientIp(request);
  if (!allowRate(ip, 'upgrade') || !allowRate(ip, selected.role === 'sender' ? 'create' : 'join')) {
    return rejectUpgrade(socket, 429, 'Rate limit exceeded', { 'Retry-After': '60' });
  }

  if (selected.role === 'sender') {
    const session = allocateSession();
    if (!session) {
      return rejectUpgrade(socket, 503, 'Unable to allocate a session', { 'Retry-After': '1' });
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      session.sender = webSocket;
      sessions.set(session.nameplate, session);
      attachSocket(webSocket, session, 'sender');
      metrics.sessionsCreated++;
      send(webSocket, {
        type: 'created',
        nameplate: session.nameplate,
        sid: session.sid,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
    });
    return;
  }

  const session = sessions.get(selected.nameplate!);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) deleteSession(session);
    return rejectUpgrade(socket, 404, 'Session is unavailable');
  }
  if (session.receiver || session.receiverReserved) {
    return rejectUpgrade(socket, 409, 'A receiver is already connected');
  }
  session.receiverReserved = true;
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    session.receiver = webSocket;
    session.receiverReserved = false;
    session.expiresAt = Date.now() + CONNECTED_TTL_MS;
    attachSocket(webSocket, session, 'receiver');
    metrics.sessionsJoined++;
    send(webSocket, {
      type: 'joined',
      nameplate: session.nameplate,
      sid: session.sid,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
    void pairSession(session);
  });
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.expiresAt > now) continue;
    sendError(session.sender, 'expired', 'Session expired');
    if (session.receiver) sendError(session.receiver, 'expired', 'Session expired');
    closeSession(session, 4003, 'expired');
  }
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.startedAt >= 60_000) rateBuckets.delete(key);
  }
}, 30_000);
cleanupTimer.unref();

server.listen(port, '0.0.0.0', () => {
  console.log(`SkillSpore rendezvous listening on port ${port}`);
});

function shutdown(): void {
  clearInterval(cleanupTimer);
  for (const session of sessions.values()) closeSession(session, 1012, 'service restart');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

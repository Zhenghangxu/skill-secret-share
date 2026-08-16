import {
  SIGNALING_LIMIT_BYTES,
  parseClientRendezvousJson,
  type ClientRendezvousMessage,
  type IceServerConfig,
  type RendezvousRole,
  type ServerRendezvousMessage,
} from '@skillspore/protocol/rendezvous';
import {
  consumeMessage,
  initialCounters,
  newestCounters,
  type SessionCounters,
  type SocketAttachment,
} from './abuse.js';
import type { Env } from './env.js';
import {
  STUN_ONLY_SERVERS,
  generateTurnCredential,
  revokeTurnCredential,
  type IssuedTurnCredential,
} from './turn.js';
import { runtimeConfig, type RuntimeConfig } from './validation.js';

interface SessionRow {
  [key: string]: SqlStorageValue;
  sid: string;
  sender_present: number;
  receiver_present: number;
  expires_at: number;
  failed_attempts: number;
  completed: number;
  sender_turn_username: string | null;
  receiver_turn_username: string | null;
  turn_key_id: string | null;
  sender_turn_expires_at: number | null;
  receiver_turn_expires_at: number | null;
}

const CREATE_SESSION_TABLE = `
  CREATE TABLE IF NOT EXISTS session (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    sid TEXT NOT NULL,
    sender_present INTEGER NOT NULL,
    receiver_present INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    failed_attempts INTEGER NOT NULL,
    completed INTEGER NOT NULL,
    sender_turn_username TEXT,
    receiver_turn_username TEXT,
    turn_key_id TEXT,
    sender_turn_expires_at INTEGER,
    receiver_turn_expires_at INTEGER
  )
`;

function randomSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function safeSend(socket: WebSocket, message: ServerRendezvousMessage): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket may have disconnected between lookup and send.
  }
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Cleanup is idempotent and a closed socket needs no further action.
  }
}

export class RendezvousSession {
  private readonly config: RuntimeConfig;
  private cleaningUp = false;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {
    this.config = runtimeConfig(env);
    this.ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(CREATE_SESSION_TABLE);
  }

  private sessionRow(): SessionRow | undefined {
    return [
      ...this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM session WHERE singleton = 1'),
    ][0];
  }

  private attachment(socket: WebSocket): SocketAttachment | undefined {
    const value = socket.deserializeAttachment() as SocketAttachment | null;
    if (!value || (value.role !== 'sender' && value.role !== 'receiver')) return undefined;
    return value;
  }

  private sockets(role?: RendezvousRole): WebSocket[] {
    return role ? this.ctx.getWebSockets(role) : this.ctx.getWebSockets();
  }

  private counters(): SessionCounters {
    const now = Date.now();
    return newestCounters(this.sockets(), initialCounters(now, this.config.messageBurst));
  }

  private updateCounters(
    counters: SessionCounters,
    changed?: WebSocket,
    invalidMessages?: number
  ): void {
    for (const socket of this.sockets()) {
      const attachment = this.attachment(socket);
      if (!attachment) continue;
      socket.serializeAttachment({
        role: attachment.role,
        invalidMessages:
          socket === changed && invalidMessages !== undefined
            ? invalidMessages
            : attachment.invalidMessages,
        counters,
      } satisfies SocketAttachment);
    }
  }

  private acceptSocket(role: RendezvousRole, counters: SessionCounters): [WebSocket, WebSocket] {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, invalidMessages: 0, counters } satisfies SocketAttachment);
    return [client, server];
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required\n', { status: 400 });
    }
    const role = request.headers.get('x-skillspore-role');
    const nameplate = request.headers.get('x-skillspore-nameplate');
    const protocol = request.headers.get('x-skillspore-protocol');
    if (
      (role !== 'sender' && role !== 'receiver') ||
      !nameplate ||
      !/^\d{4}$/.test(nameplate) ||
      !protocol
    ) {
      return new Response('Invalid internal rendezvous routing\n', { status: 400 });
    }

    let row = this.sessionRow();
    if (!row && this.cleaningUp) this.cleaningUp = false;
    if (role === 'sender') {
      if (row && row.completed === 0 && row.expires_at > Date.now()) {
        return new Response('Occupied\n', { status: 409 });
      }
      if (row) {
        await this.cleanup('expired reservation');
        this.cleaningUp = false;
        this.ensureSchema();
      }
      const sid = randomSessionId();
      const expiresAt = Date.now() + this.config.waitingTtlMs;
      this.ctx.storage.sql.exec(
        `INSERT INTO session (
          singleton, sid, sender_present, receiver_present, expires_at, failed_attempts, completed
        ) VALUES (1, ?, 1, 0, ?, 0, 0)`,
        sid,
        expiresAt
      );
      await this.ctx.storage.setAlarm(expiresAt);
      const [client, server] = this.acceptSocket(
        'sender',
        initialCounters(Date.now(), this.config.messageBurst)
      );
      safeSend(server, {
        type: 'created',
        nameplate,
        sid,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { 'sec-websocket-protocol': protocol },
      });
    }

    if (!row || row.completed !== 0 || row.expires_at <= Date.now()) {
      if (row) await this.cleanup('expired join');
      return new Response('Session is unavailable\n', { status: 404 });
    }
    if (row.receiver_present !== 0 || this.sockets('receiver').length > 0) {
      return new Response('Occupied\n', { status: 409 });
    }

    const expiresAt = Date.now() + this.config.connectedTtlMs;
    this.ctx.storage.sql.exec(
      'UPDATE session SET receiver_present = 1, expires_at = ? WHERE singleton = 1',
      expiresAt
    );
    await this.ctx.storage.setAlarm(expiresAt);
    const [client, server] = this.acceptSocket('receiver', this.counters());
    safeSend(server, {
      type: 'joined',
      nameplate,
      sid: row.sid,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    this.ctx.waitUntil(this.pairPeers(row.sid));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'sec-websocket-protocol': protocol },
    });
  }

  private async pairPeers(sid: string): Promise<void> {
    const sender = this.sockets('sender')[0];
    const receiver = this.sockets('receiver')[0];
    if (!sender || !receiver) return;
    if (this.config.turnMode === 'stun-only') {
      safeSend(sender, { type: 'paired', iceServers: STUN_ONLY_SERVERS });
      safeSend(receiver, { type: 'paired', iceServers: STUN_ONLY_SERVERS });
      return;
    }

    const generated = await Promise.allSettled([
      generateTurnCredential(this.env, sid),
      generateTurnCredential(this.env, sid),
    ]);
    const senderTurn = generated[0].status === 'fulfilled' ? generated[0].value : undefined;
    const receiverTurn = generated[1].status === 'fulfilled' ? generated[1].value : undefined;
    if (!senderTurn || !receiverTurn) {
      console.log(JSON.stringify({ event: 'turn_provider_error', operation: 'generate' }));
      await Promise.allSettled(
        [senderTurn, receiverTurn]
          .filter((credential): credential is IssuedTurnCredential => Boolean(credential))
          .map((credential) => this.revokeBounded(credential.username))
      );
      if (this.config.turnMode === 'forced-relay-test') {
        safeSend(sender, {
          type: 'error',
          code: 'service-unavailable',
          message: 'TURN credentials are unavailable',
          retryAfterMs: 1_000,
        });
        safeSend(receiver, {
          type: 'error',
          code: 'service-unavailable',
          message: 'TURN credentials are unavailable',
          retryAfterMs: 1_000,
        });
        safeClose(sender, 1013, 'TURN unavailable');
        safeClose(receiver, 1013, 'TURN unavailable');
        await this.cleanup('TURN generation failure');
        return;
      }
      safeSend(sender, { type: 'paired', iceServers: STUN_ONLY_SERVERS });
      safeSend(receiver, { type: 'paired', iceServers: STUN_ONLY_SERVERS });
      return;
    }

    const row = this.sessionRow();
    if (!row || row.completed !== 0 || !this.sockets('sender')[0] || !this.sockets('receiver')[0]) {
      await Promise.allSettled([
        this.revokeBounded(senderTurn.username),
        this.revokeBounded(receiverTurn.username),
      ]);
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE session SET
        sender_turn_username = ?, receiver_turn_username = ?, turn_key_id = ?,
        sender_turn_expires_at = ?, receiver_turn_expires_at = ?
       WHERE singleton = 1`,
      senderTurn.username,
      receiverTurn.username,
      this.env.TURN_KEY_ID,
      senderTurn.expiresAt,
      receiverTurn.expiresAt
    );
    safeSend(sender, { type: 'paired', iceServers: senderTurn.iceServers });
    safeSend(receiver, { type: 'paired', iceServers: receiverTurn.iceServers });
  }

  private invalidMessage(socket: WebSocket, message: string): void {
    const attachment = this.attachment(socket);
    if (!attachment) return safeClose(socket, 1008, 'invalid socket attachment');
    const invalidMessages = attachment.invalidMessages + 1;
    this.updateCounters(attachment.counters, socket, invalidMessages);
    safeSend(socket, { type: 'error', code: 'invalid-message', message });
    console.log(JSON.stringify({ event: 'invalid_message' }));
    if (invalidMessages >= this.config.maxInvalidMessages) {
      console.log(JSON.stringify({ event: 'abuse_socket_closed', reason: 'invalid_messages' }));
      safeClose(socket, 1008, 'too many invalid messages');
    }
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(socket);
    if (!attachment) return safeClose(socket, 1008, 'invalid socket attachment');
    if (typeof raw !== 'string')
      return this.invalidMessage(socket, 'Binary messages are not allowed');
    if (new TextEncoder().encode(raw).byteLength > SIGNALING_LIMIT_BYTES) {
      return this.invalidMessage(socket, 'Rendezvous message exceeds 64 KiB');
    }

    const counters = consumeMessage(
      this.counters(),
      Date.now(),
      this.config.messagesPerSecond,
      this.config.messageBurst,
      this.config.maxSessionMessages
    );
    if (!counters) {
      console.log(JSON.stringify({ event: 'abuse_socket_closed', reason: 'signaling_limit' }));
      safeClose(socket, 1008, 'signaling limit exceeded');
      return;
    }
    this.updateCounters(counters);

    let message: ClientRendezvousMessage;
    try {
      message = parseClientRendezvousJson(raw);
    } catch (error) {
      return this.invalidMessage(
        socket,
        error instanceof Error ? error.message : 'Rendezvous message is invalid'
      );
    }
    await this.handleMessage(socket, attachment.role, message);
  }

  private async handleMessage(
    socket: WebSocket,
    role: RendezvousRole,
    message: ClientRendezvousMessage
  ): Promise<void> {
    switch (message.type) {
      case 'relay': {
        const peer = this.sockets(role === 'sender' ? 'receiver' : 'sender')[0];
        if (!peer) {
          safeSend(socket, { type: 'error', code: 'not-paired', message: 'No peer is connected' });
          return;
        }
        safeSend(peer, { type: 'relay', payload: message.payload });
        return;
      }
      case 'attempt-failed': {
        if (role !== 'sender')
          return this.invalidMessage(socket, 'Only the sender can fail an attempt');
        const row = this.sessionRow();
        if (!row) return;
        const failedAttempts = row.failed_attempts + 1;
        const receiver = this.sockets('receiver')[0];
        if (receiver) {
          safeSend(receiver, {
            type: 'error',
            code: 'authentication-failed',
            message: 'Peer authentication failed',
          });
          safeClose(receiver, 4001, 'authentication failed');
        }
        this.ctx.storage.sql.exec(
          'UPDATE session SET failed_attempts = ?, receiver_present = 0 WHERE singleton = 1',
          failedAttempts
        );
        if (failedAttempts >= this.config.maxFailedAttempts) {
          safeSend(socket, {
            type: 'error',
            code: 'attempt-limit',
            message: 'Session invalidated after repeated failures',
          });
          safeClose(socket, 4002, 'attempt limit');
          await this.cleanup('attempt limit');
        }
        return;
      }
      case 'complete': {
        const row = this.sessionRow();
        if (!row || row.completed !== 0) return;
        this.ctx.storage.sql.exec('UPDATE session SET completed = 1 WHERE singleton = 1');
        console.log(
          JSON.stringify({
            event: 'session_completed',
            sid: row.sid,
            completedAt: new Date().toISOString(),
          })
        );
        await this.cleanup('complete');
      }
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    if (this.cleaningUp) return;
    const attachment = this.attachment(socket);
    if (!attachment) return;
    if (attachment.role === 'sender') {
      const receiver = this.sockets('receiver')[0];
      if (receiver) safeSend(receiver, { type: 'peer-left' });
      await this.cleanup('sender disconnected');
      return;
    }
    const sender = this.sockets('sender')[0];
    if (sender) safeSend(sender, { type: 'peer-left' });
    const row = this.sessionRow();
    if (row)
      this.ctx.storage.sql.exec('UPDATE session SET receiver_present = 0 WHERE singleton = 1');
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  async alarm(): Promise<void> {
    await this.cleanup('expired');
  }

  private async revokeBounded(username: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      await revokeTurnCredential(this.env, username, controller.signal);
    } catch {
      console.log(JSON.stringify({ event: 'turn_provider_error', operation: 'revoke' }));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async cleanup(reason: string): Promise<void> {
    if (this.cleaningUp) return;
    this.cleaningUp = true;
    const row = this.sessionRow();
    for (const socket of this.sockets()) {
      socket.serializeAttachment(null);
      safeClose(socket, 1000, reason);
    }
    if (row) {
      await Promise.allSettled(
        [row.sender_turn_username, row.receiver_turn_username]
          .filter((username): username is string => Boolean(username))
          .map((username) => this.revokeBounded(username))
      );
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

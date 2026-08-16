import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import {
  SIGNALING_LIMIT_BYTES,
  formatRendezvousSubprotocol,
  parseServerRendezvousJson,
  type ClientRendezvousMessage,
  type IceServerConfig,
  type RendezvousRole,
  type ServerRendezvousMessage,
  type SignalingPayload,
} from '@skillspore/protocol';
import { AsyncInbox } from './inbox.js';

const RETRYABLE_CODES = new Set(['rate-limited', 'service-unavailable']);
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;

export interface RendezvousSessionInfo {
  nameplate: string;
  sid: string;
  expiresAt: string;
}

export interface RendezvousConnectOptions {
  maxRetries?: number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export class RendezvousError extends Error {
  readonly code: string | undefined;
  readonly statusCode: number | undefined;
  readonly closeCode: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    details: {
      code?: string;
      statusCode?: number;
      closeCode?: number;
      retryAfterMs?: number;
      retryable?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'RendezvousError';
    this.code = details.code;
    this.statusCode = details.statusCode;
    this.closeCode = details.closeCode;
    this.retryAfterMs = details.retryAfterMs;
    this.retryable = details.retryable ?? false;
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    timeout.unref();
  });
}

export function retryDelayMs(
  retryIndex: number,
  random = Math.random,
  retryAfterMs?: number
): number {
  if (retryAfterMs !== undefined) return Math.min(RETRY_CAP_MS, Math.max(0, retryAfterMs));
  const maximum = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** retryIndex);
  return Math.floor(Math.max(0, Math.min(1, random())) * maximum);
}

function retryAfterHeader(response: IncomingMessage): number | undefined {
  const value = response.headers['retry-after'];
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function errorFromMessage(
  message: Extract<ServerRendezvousMessage, { type: 'error' }>
): RendezvousError {
  return new RendezvousError(`${message.code}: ${message.message}`, {
    code: message.code,
    ...(message.retryAfterMs === undefined ? {} : { retryAfterMs: message.retryAfterMs }),
    retryable: RETRYABLE_CODES.has(message.code),
  });
}

export class RendezvousClient {
  private readonly messages = new AsyncInbox<ServerRendezvousMessage>();
  private readonly relays = new AsyncInbox<SignalingPayload>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw, isBinary) => {
      try {
        if (isBinary) throw new RendezvousError('Binary rendezvous messages are not allowed');
        const message = parseServerRendezvousJson(raw.toString());
        if (message.type === 'relay') this.relays.push(message.payload);
        else if (message.type === 'error') {
          const error = errorFromMessage(message);
          this.messages.fail(error);
          this.relays.fail(error);
        } else this.messages.push(message);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new RendezvousError('Invalid rendezvous message');
        this.messages.fail(failure);
        this.relays.fail(failure);
      }
    });
    socket.on('error', (error) => {
      const failure = new RendezvousError('Rendezvous connection failed', { cause: error });
      this.messages.fail(failure);
      this.relays.fail(failure);
    });
    socket.on('close', (code, reason) => {
      const failure = new RendezvousError(
        reason.length > 0
          ? `Rendezvous connection closed: ${reason.toString()}`
          : 'Rendezvous connection closed',
        { closeCode: code, retryable: code === 1013 }
      );
      this.messages.fail(failure);
      this.relays.fail(failure);
    });
  }

  static async connect(
    url: string,
    input: { role: RendezvousRole; nameplate?: string },
    options: RendezvousConnectOptions = {}
  ): Promise<{ client: RendezvousClient; info: RendezvousSessionInfo }> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const random = options.random ?? Math.random;
    const sleep = options.sleep ?? defaultSleep;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let client: RendezvousClient | undefined;
      try {
        client = await RendezvousClient.connectOnce(url, input);
        const expected = input.role === 'sender' ? 'created' : 'joined';
        const info = await client.waitFor(expected);
        return { client, info };
      } catch (error) {
        client?.close();
        const failure = error instanceof Error ? error : new Error(String(error));
        lastError = failure;
        if (!(failure instanceof RendezvousError) || !failure.retryable || attempt >= maxRetries) {
          throw failure;
        }
        await sleep(retryDelayMs(attempt, random, failure.retryAfterMs));
      }
    }
    throw lastError ?? new RendezvousError('Rendezvous connection failed');
  }

  private static async connectOnce(
    url: string,
    input: { role: RendezvousRole; nameplate?: string }
  ): Promise<RendezvousClient> {
    const protocol = formatRendezvousSubprotocol(input.role, input.nameplate);
    const socket = new WebSocket(url, protocol, { maxPayload: SIGNALING_LIMIT_BYTES });
    const client = new RendezvousClient(socket);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      socket.once('open', () => finish(resolve));
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        const statusCode = response.statusCode ?? 500;
        finish(() =>
          reject(
            new RendezvousError(`Rendezvous upgrade failed with HTTP ${statusCode}`, {
              statusCode,
              ...(() => {
                const retryAfterMs = retryAfterHeader(response);
                return retryAfterMs === undefined ? {} : { retryAfterMs };
              })(),
              retryable: statusCode === 429 || statusCode === 503,
            })
          )
        );
      });
      socket.once('error', (error) =>
        finish(() => reject(new RendezvousError('Rendezvous connection failed', { cause: error })))
      );
      socket.once('close', (code, reason) =>
        finish(() =>
          reject(
            new RendezvousError(
              reason.length > 0
                ? `Rendezvous connection closed: ${reason.toString()}`
                : 'Rendezvous connection closed',
              { closeCode: code, retryable: code === 1013 }
            )
          )
        )
      );
    });
    if (socket.protocol !== protocol) {
      socket.close(1002, 'subprotocol mismatch');
      throw new RendezvousError('Rendezvous server selected an unexpected subprotocol');
    }
    return client;
  }

  private send(message: ClientRendezvousMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitUntilPaired(expiresAt: string): Promise<IceServerConfig[]> {
    const expiresAtMs = Date.parse(expiresAt);
    const timeoutMs = Number.isFinite(expiresAtMs) ? Math.max(1, expiresAtMs - Date.now()) : 30_000;
    const message = await this.waitFor('paired', timeoutMs);
    return message.iceServers;
  }

  sendRelay(payload: SignalingPayload): void {
    this.send({ type: 'relay', payload });
  }

  receiveRelay(timeoutMs = 30_000): Promise<SignalingPayload> {
    return this.relays.next(timeoutMs);
  }

  markAttemptFailed(): void {
    this.send({ type: 'attempt-failed' });
  }

  markComplete(): void {
    this.send({ type: 'complete' });
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.CONNECTING ||
      this.socket.readyState === WebSocket.OPEN
    ) {
      this.socket.close();
    }
  }

  private async waitFor<K extends ServerRendezvousMessage['type']>(
    type: K,
    timeoutMs = 30_000
  ): Promise<Extract<ServerRendezvousMessage, { type: K }>> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const message = await this.messages.next(Math.max(1, deadline - Date.now()));
      if (message.type === type) return message as Extract<ServerRendezvousMessage, { type: K }>;
      if (message.type === 'peer-left') throw new RendezvousError('Peer left the session');
    }
  }
}

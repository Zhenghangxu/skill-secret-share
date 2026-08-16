import WebSocket from 'ws';
import {
  SIGNALING_LIMIT_BYTES,
  formatRendezvousSubprotocol,
  parseServerRendezvousJson,
  type ServerRendezvousMessage,
} from '../packages/protocol/src/index.js';

interface LoadOptions {
  url: string;
  sessions: number;
  creationsPerSecond: number;
  messagesPerSession: number;
  abuseSessions: number;
}

class Inbox {
  private readonly values: ServerRendezvousMessage[] = [];
  private readonly waiters: Array<(value: ServerRendezvousMessage) => void> = [];

  push(value: ServerRendezvousMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  next(timeoutMs = 30_000): Promise<ServerRendezvousMessage> {
    const value = this.values.shift();
    if (value) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for rendezvous message')),
        timeoutMs
      );
      this.waiters.push((message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  }
}

interface LoadSocket {
  socket: WebSocket;
  inbox: Inbox;
}

interface LiveSession {
  sender: LoadSocket;
  receiver: LoadSocket;
}

function integerArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function stringArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function options(): LoadOptions {
  return {
    url: stringArg(
      '--url',
      process.env.SKILLSPORE_SERVER_URL ?? 'ws://127.0.0.1:8787/v1/rendezvous'
    ),
    sessions: integerArg('--sessions', 10),
    creationsPerSecond: integerArg('--creations-per-second', 10),
    messagesPerSession: integerArg('--messages-per-session', 40),
    abuseSessions: integerArg('--abuse-sessions', 0),
  };
}

function connect(url: string, protocol: string): Promise<LoadSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol, { maxPayload: SIGNALING_LIMIT_BYTES });
    const inbox = new Inbox();
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return reject(new Error('Server returned a binary rendezvous message'));
      const message = parseServerRendezvousJson(raw.toString());
      if (message.type === 'error') return reject(new Error(`${message.code}: ${message.message}`));
      inbox.push(message);
    });
    socket.once('open', () => resolve({ socket, inbox }));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`Upgrade returned HTTP ${response.statusCode}`));
    });
    socket.once('error', reject);
  });
}

async function waitFor<K extends ServerRendezvousMessage['type']>(
  client: LoadSocket,
  type: K
): Promise<Extract<ServerRendezvousMessage, { type: K }>> {
  while (true) {
    const message = await client.inbox.next();
    if (message.type === type) return message as Extract<ServerRendezvousMessage, { type: K }>;
  }
}

async function createSession(
  input: LoadOptions,
  createLatencies: number[],
  joinLatencies: number[],
  relayLatencies: number[]
): Promise<LiveSession> {
  const createStarted = performance.now();
  const sender = await connect(input.url, formatRendezvousSubprotocol('sender'));
  const created = await waitFor(sender, 'created');
  createLatencies.push(performance.now() - createStarted);

  const joinStarted = performance.now();
  const receiver = await connect(
    input.url,
    formatRendezvousSubprotocol('receiver', created.nameplate)
  );
  await waitFor(receiver, 'joined');
  await Promise.all([waitFor(sender, 'paired'), waitFor(receiver, 'paired')]);
  joinLatencies.push(performance.now() - joinStarted);

  const senderExpected = Math.floor(input.messagesPerSession / 2);
  const receiverExpected = input.messagesPerSession - senderExpected;
  const relayStarted = performance.now();
  for (let index = 0; index < input.messagesPerSession; index++) {
    const source = index % 2 === 0 ? sender : receiver;
    source.socket.send(
      JSON.stringify({
        type: 'relay',
        payload: { type: 'candidate', candidate: `candidate:${index}`, mid: '0' },
      })
    );
  }
  await Promise.all([
    ...Array.from({ length: senderExpected }, () => waitFor(sender, 'relay')),
    ...Array.from({ length: receiverExpected }, () => waitFor(receiver, 'relay')),
  ]);
  relayLatencies.push((performance.now() - relayStarted) / Math.max(1, input.messagesPerSession));
  return { sender, receiver };
}

async function createAbuseSession(input: LoadOptions): Promise<void> {
  const sender = await connect(input.url, formatRendezvousSubprotocol('sender'));
  await waitFor(sender, 'created');
  for (let index = 0; index < 5; index++) sender.socket.send(JSON.stringify({ type: 'create' }));
  sender.socket.close();
}

function percentile(values: number[], percent: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percent) - 1)]!;
}

async function main(): Promise<void> {
  const input = options();
  if (input.creationsPerSecond === 0) throw new Error('--creations-per-second must be positive');
  const createLatencies: number[] = [];
  const joinLatencies: number[] = [];
  const relayLatencies: number[] = [];
  const live: LiveSession[] = [];
  const errors: string[] = [];
  const startedAt = performance.now();

  for (let offset = 0; offset < input.sessions; offset += input.creationsPerSecond) {
    const batch = Math.min(input.creationsPerSecond, input.sessions - offset);
    const batchStarted = performance.now();
    const results = await Promise.allSettled(
      Array.from({ length: batch }, () =>
        createSession(input, createLatencies, joinLatencies, relayLatencies)
      )
    );
    for (const result of results) {
      if (result.status === 'fulfilled') live.push(result.value);
      else
        errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
    const remaining = 1000 - (performance.now() - batchStarted);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  await Promise.allSettled(
    Array.from({ length: input.abuseSessions }, () => createAbuseSession(input))
  );
  for (const session of live) {
    session.sender.socket.send(JSON.stringify({ type: 'complete' }));
    session.sender.socket.close();
    session.receiver.socket.close();
  }

  console.log(
    JSON.stringify(
      {
        attemptedSessions: input.sessions,
        successfulSessions: live.length,
        failedSessions: errors.length,
        durationMs: Math.round(performance.now() - startedAt),
        createLatencyMs: {
          p50: Math.round(percentile(createLatencies, 0.5)),
          p95: Math.round(percentile(createLatencies, 0.95)),
          p99: Math.round(percentile(createLatencies, 0.99)),
        },
        joinLatencyMs: {
          p50: Math.round(percentile(joinLatencies, 0.5)),
          p95: Math.round(percentile(joinLatencies, 0.95)),
          p99: Math.round(percentile(joinLatencies, 0.99)),
        },
        averageRelayLatencyMs: Math.round(
          relayLatencies.reduce((total, value) => total + value, 0) /
            Math.max(1, relayLatencies.length)
        ),
        errors: errors.slice(0, 20),
      },
      null,
      2
    )
  );
  if (errors.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

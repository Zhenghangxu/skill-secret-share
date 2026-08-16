import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { consumeMessage, initialCounters } from './abuse.js';

class SocketInbox {
  private readonly values: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];

  constructor(socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(String(event.data)) as unknown;
      const waiter = this.waiters.shift();
      if (waiter) waiter(value);
      else this.values.push(value);
    });
  }

  next(): Promise<unknown> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

describe('rendezvous Worker', () => {
  it('serves health without allocating a session', async () => {
    const response = await SELF.fetch('https://example.test/healthz');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('rejects missing and contradictory subprotocols before upgrade', async () => {
    const missing = await SELF.fetch('https://example.test/v1/rendezvous', {
      headers: { upgrade: 'websocket', 'cf-connecting-ip': '192.0.2.1' },
    });
    expect(missing.status).toBe(400);
    const multiple = await SELF.fetch('https://example.test/v1/rendezvous', {
      headers: {
        upgrade: 'websocket',
        'cf-connecting-ip': '192.0.2.2',
        'sec-websocket-protocol': 'skillspore.v1.sender, skillspore.v1.receiver.0042',
      },
    });
    expect(multiple.status).toBe(400);
  });

  it('routes a sender directly to a Durable Object and echoes the protocol', async () => {
    const response = await SELF.fetch('https://example.test/v1/rendezvous', {
      headers: {
        upgrade: 'websocket',
        'cf-connecting-ip': '192.0.2.3',
        'sec-websocket-protocol': 'skillspore.v1.sender',
      },
    });
    expect(response.status).toBe(101);
    expect(response.headers.get('sec-websocket-protocol')).toBe('skillspore.v1.sender');
    const socket = response.webSocket!;
    const inbox = new SocketInbox(socket);
    socket.accept();
    await expect(inbox.next()).resolves.toMatchObject({
      type: 'created',
      nameplate: expect.stringMatching(/^\d{4}$/),
      sid: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    socket.close(1000, 'test complete');
  });

  it('pairs role-specific sockets and relays only validated signaling JSON', async () => {
    const senderResponse = await SELF.fetch('https://example.test/v1/rendezvous', {
      headers: {
        upgrade: 'websocket',
        'cf-connecting-ip': '192.0.2.4',
        'sec-websocket-protocol': 'skillspore.v1.sender',
      },
    });
    const sender = senderResponse.webSocket!;
    const senderInbox = new SocketInbox(sender);
    sender.accept();
    const created = (await senderInbox.next()) as { nameplate: string };

    const receiverResponse = await SELF.fetch('https://example.test/v1/rendezvous', {
      headers: {
        upgrade: 'websocket',
        'cf-connecting-ip': '192.0.2.5',
        'sec-websocket-protocol': `skillspore.v1.receiver.${created.nameplate}`,
      },
    });
    expect(receiverResponse.status).toBe(101);
    const receiver = receiverResponse.webSocket!;
    const receiverInbox = new SocketInbox(receiver);
    receiver.accept();
    await expect(receiverInbox.next()).resolves.toMatchObject({ type: 'joined' });
    await expect(senderInbox.next()).resolves.toMatchObject({ type: 'paired' });
    await expect(receiverInbox.next()).resolves.toMatchObject({ type: 'paired' });

    const relayed = receiverInbox.next();
    sender.send(
      JSON.stringify({
        type: 'relay',
        payload: { type: 'candidate', candidate: 'candidate:1', mid: '0' },
      })
    );
    await expect(relayed).resolves.toEqual({
      type: 'relay',
      payload: { type: 'candidate', candidate: 'candidate:1', mid: '0' },
    });

    const obsolete = senderInbox.next();
    sender.send(JSON.stringify({ type: 'create' }));
    await expect(obsolete).resolves.toMatchObject({ type: 'error', code: 'invalid-message' });
    sender.close(1000, 'test complete');
    receiver.close(1000, 'test complete');
  });
});

describe('session signaling token bucket', () => {
  it('allows the configured burst and then refills over time', () => {
    let counters = initialCounters(1_000, 2);
    counters = consumeMessage(counters, 1_000, 1, 2, 10)!;
    counters = consumeMessage(counters, 1_000, 1, 2, 10)!;
    expect(consumeMessage(counters, 1_000, 1, 2, 10)).toBeUndefined();
    expect(consumeMessage(counters, 2_000, 1, 2, 10)).toMatchObject({ lifetimeMessages: 3 });
  });
});

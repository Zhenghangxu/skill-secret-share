import { describe, expect, it, vi } from 'vitest';
import { RendezvousClient, retryDelayMs } from './rendezvous.js';
import { connectSecurePeer } from './secure-peer.js';

describe('secure peer rendezvous lifetime', () => {
  it('uses full jitter and honors a bounded server retry delay', () => {
    expect(retryDelayMs(0, () => 0.5)).toBe(250);
    expect(retryDelayMs(4, () => 1)).toBe(5_000);
    expect(retryDelayMs(0, () => 0, 1_250)).toBe(1_250);
    expect(retryDelayMs(0, () => 0, 10_000)).toBe(5_000);
  });

  it('waits for pairing until the rendezvous session expires', async () => {
    const now = Date.parse('2026-08-08T22:00:00.000Z');
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
    const next = vi.fn().mockResolvedValue({
      type: 'paired',
      iceServers: [{ urls: 'stun:example.test' }],
    });
    const client = Object.create(RendezvousClient.prototype) as RendezvousClient;
    Object.defineProperty(client, 'messages', { value: { next } });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    try {
      await expect(client.waitUntilPaired(expiresAt)).resolves.toEqual([
        { urls: 'stun:example.test' },
      ]);
      expect(next).toHaveBeenCalledWith(10 * 60 * 1000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('passes the advertised expiration to the pairing wait', async () => {
    const expiresAt = '2026-08-08T22:10:00.000Z';
    const stop = new Error('stop after pairing wait');
    const waitUntilPaired = vi.fn().mockRejectedValue(stop);
    const rendezvous = { waitUntilPaired } as unknown as RendezvousClient;

    await expect(
      connectSecurePeer({
        openSession: {
          rendezvous,
          info: {
            nameplate: '1234',
            sid: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            expiresAt,
          },
        },
        secret: 'alpha-beta-gamma',
        role: 'sender',
      })
    ).rejects.toBe(stop);

    expect(waitUntilPaired).toHaveBeenCalledWith(expiresAt);
  });
});

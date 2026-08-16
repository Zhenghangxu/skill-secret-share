import type { RendezvousRole } from '@skillspore/protocol/rendezvous';

export interface SessionCounters {
  revision: number;
  lifetimeMessages: number;
  tokens: number;
  updatedAt: number;
}

export interface SocketAttachment {
  role: RendezvousRole;
  invalidMessages: number;
  counters: SessionCounters;
}

export function initialCounters(now: number, burst: number): SessionCounters {
  return { revision: 0, lifetimeMessages: 0, tokens: burst, updatedAt: now };
}

export function newestCounters(sockets: WebSocket[], fallback: SessionCounters): SessionCounters {
  let newest = fallback;
  for (const socket of sockets) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.counters && attachment.counters.revision > newest.revision) {
      newest = attachment.counters;
    }
  }
  return { ...newest };
}

export function consumeMessage(
  counters: SessionCounters,
  now: number,
  ratePerSecond: number,
  burst: number,
  lifetimeLimit: number
): SessionCounters | undefined {
  const elapsedSeconds = Math.max(0, now - counters.updatedAt) / 1000;
  const tokens = Math.min(burst, counters.tokens + elapsedSeconds * ratePerSecond);
  if (tokens < 1 || counters.lifetimeMessages >= lifetimeLimit) return undefined;
  return {
    revision: counters.revision + 1,
    lifetimeMessages: counters.lifetimeMessages + 1,
    tokens: tokens - 1,
    updatedAt: now,
  };
}

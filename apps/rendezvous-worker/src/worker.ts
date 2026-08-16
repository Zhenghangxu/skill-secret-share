import {
  RENDEZVOUS_PATH,
  parseRendezvousSubprotocol,
  type RendezvousSubprotocol,
} from '@skillspore/protocol/rendezvous';
import type { Env } from './env.js';
import { runtimeConfig } from './validation.js';

export { RendezvousSession } from './session-object.js';

function response(status: number, message: string, retryAfterSeconds?: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
    },
  });
}

function randomNameplate(): string {
  const value = new Uint16Array(1);
  do crypto.getRandomValues(value);
  while (value[0]! >= 60_000);
  return String(value[0]! % 10_000).padStart(4, '0');
}

async function rateAllowed(limiter: RateLimit, key: string): Promise<boolean> {
  return (await limiter.limit({ key })).success;
}

function routedRequest(
  request: Request,
  selected: RendezvousSubprotocol,
  nameplate: string
): Request {
  const headers = new Headers(request.headers);
  headers.set('x-skillspore-role', selected.role);
  headers.set('x-skillspore-nameplate', nameplate);
  headers.set('x-skillspore-protocol', selected.protocol);
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname !== RENDEZVOUS_PATH) return response(404, 'Not found');
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return response(400, 'WebSocket upgrade required');
    }

    let selected: RendezvousSubprotocol;
    try {
      selected = parseRendezvousSubprotocol(request.headers.get('sec-websocket-protocol'));
    } catch (error) {
      return response(400, error instanceof Error ? error.message : 'Invalid subprotocol');
    }

    const config = runtimeConfig(env);
    if (config.sessionsMode === 'disabled') return response(503, 'New sessions are disabled', 60);
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!(await rateAllowed(env.UPGRADE_IP_LIMITER, ip)))
      return response(429, 'Rate limit exceeded', 60);
    const roleLimiter = selected.role === 'sender' ? env.CREATE_IP_LIMITER : env.JOIN_IP_LIMITER;
    if (!(await rateAllowed(roleLimiter, ip))) return response(429, 'Rate limit exceeded', 60);

    if (selected.role === 'receiver') {
      const nameplate = selected.nameplate!;
      return env.SESSIONS.get(env.SESSIONS.idFromName(nameplate)).fetch(
        routedRequest(request, selected, nameplate)
      );
    }

    for (let attempt = 0; attempt < config.maxNameplateAttempts; attempt++) {
      const nameplate = randomNameplate();
      const result = await env.SESSIONS.get(env.SESSIONS.idFromName(nameplate)).fetch(
        routedRequest(request, selected, nameplate)
      );
      if (result.status === 409) continue;
      return result;
    }
    return response(503, 'Unable to allocate a session', 1);
  },
} satisfies ExportedHandler<Env>;

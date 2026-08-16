import { parseIceServerConfig, type IceServerConfig } from '@skillspore/protocol/rendezvous';
import type { Env } from './env.js';

export const STUN_ONLY_SERVERS: IceServerConfig[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
];

export interface IssuedTurnCredential {
  iceServers: IceServerConfig[];
  username: string;
  expiresAt: number;
}

function credentialUsername(iceServers: IceServerConfig[]): string | undefined {
  return iceServers.find((server) => server.username)?.username;
}

export async function generateTurnCredential(
  env: Env,
  customIdentifier: string,
  signal?: AbortSignal
): Promise<IssuedTurnCredential> {
  const ttl = Number(env.TURN_CREDENTIAL_TTL_SECONDS);
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ttl, customIdentifier }),
      ...(signal === undefined ? {} : { signal }),
    }
  );
  if (!response.ok) throw new Error(`TURN credential generation returned HTTP ${response.status}`);
  const payload = (await response.json()) as Record<string, unknown>;
  let iceServers: IceServerConfig[];
  if (Array.isArray(payload.iceServers)) {
    iceServers = payload.iceServers.map(parseIceServerConfig);
  } else {
    const username = payload.username;
    const credential = payload.credential;
    if (typeof username !== 'string' || typeof credential !== 'string') {
      throw new Error('TURN credential response is invalid');
    }
    iceServers = [
      ...STUN_ONLY_SERVERS,
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:53?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turn:turn.cloudflare.com:80?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
          'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username,
        credential,
      },
    ];
  }
  const username = credentialUsername(iceServers);
  if (!username) throw new Error('TURN credential response contains no username');
  return { iceServers, username, expiresAt: Date.now() + ttl * 1000 };
}

export async function revokeTurnCredential(
  env: Env,
  username: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/${encodeURIComponent(username)}/revoke`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}` },
      ...(signal === undefined ? {} : { signal }),
    }
  );
  if (response.status !== 204)
    throw new Error(`TURN credential revocation returned HTTP ${response.status}`);
}

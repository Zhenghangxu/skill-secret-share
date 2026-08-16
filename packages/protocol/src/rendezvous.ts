import type {
  ClientRendezvousMessage,
  IceServerConfig,
  ServerRendezvousMessage,
  SignalingPayload,
} from './types.js';

export type {
  ClientRendezvousMessage,
  IceServerConfig,
  ServerRendezvousMessage,
  SignalingPayload,
} from './types.js';

export const RENDEZVOUS_PATH = '/v1/rendezvous';
export const SIGNALING_LIMIT_BYTES = 64 * 1024;

export type RendezvousRole = 'sender' | 'receiver';

export interface RendezvousSubprotocol {
  protocol: string;
  role: RendezvousRole;
  nameplate?: string;
}

const NAMEPLATE_PATTERN = /^\d{4}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

function requireSessionInfo(value: Record<string, unknown>): {
  nameplate: string;
  sid: string;
  expiresAt: string;
} {
  const nameplate = requireString(value.nameplate, 'Nameplate');
  if (!NAMEPLATE_PATTERN.test(nameplate)) throw new Error('Nameplate must contain four digits');
  const sid = requireString(value.sid, 'Session ID');
  if (!SESSION_ID_PATTERN.test(sid)) throw new Error('Session ID is invalid');
  const expiresAt = requireString(value.expiresAt, 'Expiration');
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('Expiration is invalid');
  return { nameplate, sid, expiresAt };
}

export function formatRendezvousSubprotocol(role: RendezvousRole, nameplate?: string): string {
  if (role === 'sender') {
    if (nameplate !== undefined) throw new Error('Sender subprotocol cannot include a nameplate');
    return 'skillspore.v1.sender';
  }
  if (!nameplate || !NAMEPLATE_PATTERN.test(nameplate)) {
    throw new Error('Receiver subprotocol requires a four-digit nameplate');
  }
  return `skillspore.v1.receiver.${nameplate}`;
}

export function parseRendezvousSubprotocol(
  header: string | null | undefined
): RendezvousSubprotocol {
  const protocols = header
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!protocols || protocols.length !== 1) {
    throw new Error('Exactly one SkillSpore WebSocket subprotocol is required');
  }
  const protocol = protocols[0]!;
  if (protocol === 'skillspore.v1.sender') return { protocol, role: 'sender' };
  const match = protocol.match(/^skillspore\.v1\.receiver\.(\d{4})$/);
  if (!match) throw new Error('SkillSpore WebSocket subprotocol is invalid');
  return { protocol, role: 'receiver', nameplate: match[1]! };
}

export function parseIceServerConfig(value: unknown): IceServerConfig {
  if (!isRecord(value) || !hasOnlyKeys(value, ['urls', 'username', 'credential'])) {
    throw new Error('ICE server configuration is invalid');
  }
  const urls = Array.isArray(value.urls)
    ? value.urls.map((url) => requireString(url, 'ICE server URL'))
    : requireString(value.urls, 'ICE server URL');
  if (Array.isArray(urls) && urls.length === 0) throw new Error('ICE server URLs cannot be empty');
  const username = value.username;
  const credential = value.credential;
  if ((username === undefined) !== (credential === undefined)) {
    throw new Error('ICE username and credential must be supplied together');
  }
  if (username !== undefined && typeof username !== 'string')
    throw new Error('ICE username is invalid');
  if (credential !== undefined && typeof credential !== 'string') {
    throw new Error('ICE credential is invalid');
  }
  return {
    urls,
    ...(username === undefined ? {} : { username }),
    ...(credential === undefined ? {} : { credential }),
  };
}

export function parseSignalingPayload(value: unknown): SignalingPayload {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Signaling payload must be an object with a type');
  }
  switch (value.type) {
    case 'pake-share':
      if (!hasOnlyKeys(value, ['type', 'share']))
        throw new Error('PAKE signaling payload is invalid');
      return { type: 'pake-share', share: requireString(value.share, 'PAKE share') };
    case 'description': {
      if (!hasOnlyKeys(value, ['type', 'sdp', 'descriptionType'])) {
        throw new Error('Description signaling payload is invalid');
      }
      const descriptionType = value.descriptionType;
      if (descriptionType !== 'offer' && descriptionType !== 'answer') {
        throw new Error('Description type is invalid');
      }
      return {
        type: 'description',
        sdp: requireString(value.sdp, 'Session description'),
        descriptionType,
      };
    }
    case 'candidate':
      if (!hasOnlyKeys(value, ['type', 'candidate', 'mid'])) {
        throw new Error('Candidate signaling payload is invalid');
      }
      return {
        type: 'candidate',
        candidate: requireString(value.candidate, 'ICE candidate'),
        mid: requireString(value.mid, 'ICE candidate MID'),
      };
    default:
      throw new Error('Unknown signaling payload type');
  }
}

export function parseClientRendezvousMessage(value: unknown): ClientRendezvousMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Rendezvous message must be an object with a type');
  }
  switch (value.type) {
    case 'relay':
      if (!hasOnlyKeys(value, ['type', 'payload'])) throw new Error('Relay message is invalid');
      return { type: 'relay', payload: parseSignalingPayload(value.payload) };
    case 'attempt-failed':
    case 'complete':
      if (!hasOnlyKeys(value, ['type'])) throw new Error('Rendezvous message is invalid');
      return { type: value.type };
    default:
      throw new Error('Unknown rendezvous message type');
  }
}

export function parseServerRendezvousMessage(value: unknown): ServerRendezvousMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Rendezvous message must be an object with a type');
  }
  switch (value.type) {
    case 'created':
    case 'joined': {
      if (!hasOnlyKeys(value, ['type', 'nameplate', 'sid', 'expiresAt'])) {
        throw new Error('Session message is invalid');
      }
      return { type: value.type, ...requireSessionInfo(value) };
    }
    case 'paired':
      if (!hasOnlyKeys(value, ['type', 'iceServers']) || !Array.isArray(value.iceServers)) {
        throw new Error('Paired message is invalid');
      }
      return { type: 'paired', iceServers: value.iceServers.map(parseIceServerConfig) };
    case 'relay':
      if (!hasOnlyKeys(value, ['type', 'payload'])) throw new Error('Relay message is invalid');
      return { type: 'relay', payload: parseSignalingPayload(value.payload) };
    case 'peer-left':
      if (!hasOnlyKeys(value, ['type'])) throw new Error('Peer-left message is invalid');
      return { type: 'peer-left' };
    case 'error': {
      if (!hasOnlyKeys(value, ['type', 'code', 'message', 'retryAfterMs'])) {
        throw new Error('Error message is invalid');
      }
      const retryAfterMs = value.retryAfterMs;
      if (
        retryAfterMs !== undefined &&
        (!Number.isFinite(retryAfterMs) || Number(retryAfterMs) < 0)
      ) {
        throw new Error('Retry delay is invalid');
      }
      return {
        type: 'error',
        code: requireString(value.code, 'Error code'),
        message: requireString(value.message, 'Error message'),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs: Number(retryAfterMs) }),
      };
    }
    default:
      throw new Error('Unknown rendezvous message type');
  }
}

function parseJsonWithinLimit(raw: string, parser: (value: unknown) => unknown): unknown {
  if (new TextEncoder().encode(raw).byteLength > SIGNALING_LIMIT_BYTES) {
    throw new Error('Rendezvous message exceeds 64 KiB');
  }
  return parser(JSON.parse(raw) as unknown);
}

export function parseClientRendezvousJson(raw: string): ClientRendezvousMessage {
  return parseJsonWithinLimit(raw, parseClientRendezvousMessage) as ClientRendezvousMessage;
}

export function parseServerRendezvousJson(raw: string): ServerRendezvousMessage {
  return parseJsonWithinLimit(raw, parseServerRendezvousMessage) as ServerRendezvousMessage;
}

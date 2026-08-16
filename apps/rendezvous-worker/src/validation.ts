import type { Env, TurnMode } from './env.js';

export interface RuntimeConfig {
  waitingTtlMs: number;
  connectedTtlMs: number;
  maxFailedAttempts: number;
  maxNameplateAttempts: number;
  maxInvalidMessages: number;
  messagesPerSecond: number;
  messageBurst: number;
  maxSessionMessages: number;
  sessionsMode: 'enabled' | 'disabled';
  turnMode: TurnMode;
  turnCredentialTtlSeconds: number;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

export function runtimeConfig(env: Env): RuntimeConfig {
  if (env.SESSIONS_MODE !== 'enabled' && env.SESSIONS_MODE !== 'disabled') {
    throw new Error('SESSIONS_MODE is invalid');
  }
  if (!['best-effort', 'stun-only', 'forced-relay-test'].includes(env.TURN_MODE)) {
    throw new Error('TURN_MODE is invalid');
  }
  return {
    waitingTtlMs: positiveInteger(env.WAITING_TTL_SECONDS, 'WAITING_TTL_SECONDS') * 1000,
    connectedTtlMs: positiveInteger(env.CONNECTED_TTL_SECONDS, 'CONNECTED_TTL_SECONDS') * 1000,
    maxFailedAttempts: positiveInteger(env.MAX_FAILED_ATTEMPTS, 'MAX_FAILED_ATTEMPTS'),
    maxNameplateAttempts: positiveInteger(env.MAX_NAMEPLATE_ATTEMPTS, 'MAX_NAMEPLATE_ATTEMPTS'),
    maxInvalidMessages: positiveInteger(
      env.MAX_INVALID_MESSAGES_PER_SOCKET,
      'MAX_INVALID_MESSAGES_PER_SOCKET'
    ),
    messagesPerSecond: positiveInteger(
      env.MAX_SIGNALING_MESSAGES_PER_SECOND,
      'MAX_SIGNALING_MESSAGES_PER_SECOND'
    ),
    messageBurst: positiveInteger(env.SIGNALING_MESSAGE_BURST, 'SIGNALING_MESSAGE_BURST'),
    maxSessionMessages: positiveInteger(
      env.MAX_SIGNALING_MESSAGES_PER_SESSION,
      'MAX_SIGNALING_MESSAGES_PER_SESSION'
    ),
    sessionsMode: env.SESSIONS_MODE,
    turnMode: env.TURN_MODE,
    turnCredentialTtlSeconds: positiveInteger(
      env.TURN_CREDENTIAL_TTL_SECONDS,
      'TURN_CREDENTIAL_TTL_SECONDS'
    ),
  };
}

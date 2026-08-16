export type TurnMode = 'best-effort' | 'stun-only' | 'forced-relay-test';

export interface Env {
  SESSIONS: DurableObjectNamespace;
  UPGRADE_IP_LIMITER: RateLimit;
  CREATE_IP_LIMITER: RateLimit;
  JOIN_IP_LIMITER: RateLimit;
  WAITING_TTL_SECONDS: string;
  CONNECTED_TTL_SECONDS: string;
  MAX_FAILED_ATTEMPTS: string;
  MAX_NAMEPLATE_ATTEMPTS: string;
  MAX_INVALID_MESSAGES_PER_SOCKET: string;
  MAX_SIGNALING_MESSAGES_PER_SECOND: string;
  SIGNALING_MESSAGE_BURST: string;
  MAX_SIGNALING_MESSAGES_PER_SESSION: string;
  SESSIONS_MODE: 'enabled' | 'disabled';
  TURN_MODE: TurnMode;
  TURN_CREDENTIAL_TTL_SECONDS: string;
  MONTHLY_COST_TARGET_USD: string;
  TURN_WARNING_GB: string;
  TURN_STOP_GB: string;
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
}

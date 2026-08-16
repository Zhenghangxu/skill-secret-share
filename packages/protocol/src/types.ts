export const PROTOCOL_VERSION = 1 as const;

export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}

export interface PackageManifest {
  protocolVersion: typeof PROTOCOL_VERSION;
  transferId: string;
  skill: SkillMetadata;
  files: ManifestFile[];
  totalBytes: number;
  packageHash: string;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ClientRendezvousMessage =
  { type: 'relay'; payload: SignalingPayload } | { type: 'attempt-failed' } | { type: 'complete' };

export type ServerRendezvousMessage =
  | {
      type: 'created';
      nameplate: string;
      sid: string;
      expiresAt: string;
    }
  | {
      type: 'joined';
      nameplate: string;
      sid: string;
      expiresAt: string;
    }
  | { type: 'paired'; iceServers: IceServerConfig[] }
  | { type: 'relay'; payload: SignalingPayload }
  | { type: 'peer-left' }
  | { type: 'error'; code: string; message: string; retryAfterMs?: number };

export type SignalingPayload =
  | { type: 'pake-share'; share: string }
  | { type: 'description'; sdp: string; descriptionType: 'offer' | 'answer' }
  | { type: 'candidate'; candidate: string; mid: string };

export type ControlMessage =
  | { type: 'auth'; role: 'sender' | 'receiver'; mac: string }
  | { type: 'manifest'; manifest: PackageManifest }
  | { type: 'accept-transfer' }
  | { type: 'reject-transfer'; reason?: string }
  | { type: 'file-complete'; fileIndex: number }
  | { type: 'transfer-complete' }
  | {
      type: 'receipt';
      packageHash: string;
      totalBytes: number;
      transferId: string;
      mac: string;
    }
  | { type: 'receipt-ack' }
  | { type: 'cancel'; reason?: string };

export interface TransportFingerprint {
  algorithm: string;
  value: string;
}

export interface SessionBinding {
  protocolVersion: typeof PROTOCOL_VERSION;
  sid: string;
  nameplate: string;
  initiatorFingerprint: TransportFingerprint;
  responderFingerprint: TransportFingerprint;
}

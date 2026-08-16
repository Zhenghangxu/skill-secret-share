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

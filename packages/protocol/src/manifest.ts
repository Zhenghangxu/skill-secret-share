import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical.js';
import {
  PROTOCOL_VERSION,
  type ManifestFile,
  type PackageManifest,
  type SkillMetadata,
} from './types.js';

export function computePackageHash(manifest: Omit<PackageManifest, 'packageHash'>): string {
  return sha256Hex(canonicalJson(manifest));
}

export function createManifest(input: {
  skill: SkillMetadata;
  files: ManifestFile[];
  transferId?: string;
}): PackageManifest {
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const unsigned: Omit<PackageManifest, 'packageHash'> = {
    protocolVersion: PROTOCOL_VERSION,
    transferId: input.transferId ?? randomUUID(),
    skill: input.skill,
    files,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  };
  return { ...unsigned, packageHash: computePackageHash(unsigned) };
}

export function verifyManifest(manifest: PackageManifest): boolean {
  if (manifest.protocolVersion !== PROTOCOL_VERSION) return false;
  const { packageHash, ...unsigned } = manifest;
  return computePackageHash(unsigned) === packageHash;
}

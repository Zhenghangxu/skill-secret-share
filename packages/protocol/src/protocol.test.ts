import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  computePackageHash,
  createManifest,
  generateSecretPhrase,
  normalizePasscode,
  validateCustomSecret,
  verifyManifest,
} from './index.js';

describe('croc passcodes', () => {
  it('generates a memorable four-word passcode', () => {
    expect(generateSecretPhrase().split('-')).toHaveLength(4);
  });

  it('normalizes received codes and enforces stronger custom sender codes', () => {
    expect(normalizePasscode(' Alpha  Beta  Gamma  Delta ')).toBe('alpha-beta-gamma-delta');
    expect(() => validateCustomSecret('short')).toThrow();
    expect(validateCustomSecret('three distinct words')).toBe('three-distinct-words');
  });
});

describe('skill package manifests', () => {
  it('creates deterministic manifests and detects tampering', () => {
    const manifest = createManifest({
      transferId: 'test-transfer',
      skill: { name: 'example', description: 'Example' },
      files: [
        { path: 'b.txt', size: 2, sha256: 'b'.repeat(64), executable: false },
        { path: 'a.txt', size: 1, sha256: 'a'.repeat(64), executable: false },
      ],
    });
    expect(manifest.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt']);
    expect(verifyManifest(manifest)).toBe(true);
    expect(
      computePackageHash({
        protocolVersion: PROTOCOL_VERSION,
        transferId: manifest.transferId,
        skill: manifest.skill,
        files: manifest.files,
        totalBytes: manifest.totalBytes,
      })
    ).toBe(manifest.packageHash);
    expect(verifyManifest({ ...manifest, totalBytes: 99 })).toBe(false);
  });
});

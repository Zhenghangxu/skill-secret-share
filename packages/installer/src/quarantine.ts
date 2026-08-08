import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalJson, decodeFileFrame, type PackageManifest } from '@skillspore/protocol';
import { resolveManifestPath, validateIncomingManifest, validateSkill } from './skill.js';

export class QuarantineWriter {
  readonly rootDir: string;
  readonly manifest: PackageManifest;
  private readonly cleanupDir: string;
  private readonly offsets: number[];
  private closed = false;

  private constructor(rootDir: string, cleanupDir: string, manifest: PackageManifest) {
    this.rootDir = rootDir;
    this.cleanupDir = cleanupDir;
    this.manifest = manifest;
    this.offsets = manifest.files.map(() => 0);
  }

  static async create(manifest: PackageManifest): Promise<QuarantineWriter> {
    validateIncomingManifest(manifest);
    const cleanupDir = await mkdtemp(join(tmpdir(), 'skillspore-quarantine-'));
    const rootDir = join(cleanupDir, manifest.skill.name);
    await mkdir(rootDir, { recursive: true });
    await chmod(rootDir, 0o700).catch(() => undefined);
    for (const file of manifest.files.filter((entry) => entry.size === 0)) {
      const target = resolveManifestPath(rootDir, file.path);
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, 'wx', 0o600);
      await handle.close();
    }
    return new QuarantineWriter(rootDir, cleanupDir, manifest);
  }

  async writeFrame(encoded: Buffer): Promise<void> {
    if (this.closed) throw new Error('Quarantine is closed');
    const frame = decodeFileFrame(encoded);
    const file = this.manifest.files[frame.fileIndex];
    if (!file) throw new Error(`Unknown file index: ${frame.fileIndex}`);
    if (frame.offset !== this.offsets[frame.fileIndex])
      throw new Error(`Unexpected offset for ${file.path}`);
    if (frame.offset + frame.data.length > file.size)
      throw new Error(`Received too much data for ${file.path}`);
    const target = resolveManifestPath(this.rootDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, frame.offset === 0 ? 'wx' : 'r+');
    try {
      await handle.write(frame.data, 0, frame.data.length, frame.offset);
    } finally {
      await handle.close();
    }
    this.offsets[frame.fileIndex] = frame.offset + frame.data.length;
  }

  async verify(): Promise<void> {
    this.closed = true;
    for (let index = 0; index < this.manifest.files.length; index++) {
      const file = this.manifest.files[index]!;
      if (this.offsets[index] !== file.size) throw new Error(`Incomplete file: ${file.path}`);
      const target = resolveManifestPath(this.rootDir, file.path);
      const stats = await stat(target);
      if (!stats.isFile() || stats.size !== file.size)
        throw new Error(`Invalid received file: ${file.path}`);
      const hash = createHash('sha256')
        .update(await readFile(target))
        .digest('hex');
      if (hash !== file.sha256) throw new Error(`Integrity check failed: ${file.path}`);
      if (file.executable) await chmod(target, 0o700).catch(() => undefined);
      else await chmod(target, 0o600).catch(() => undefined);
    }
    const receivedMetadata = await validateSkill(this.rootDir);
    if (canonicalJson(receivedMetadata) !== canonicalJson(this.manifest.skill)) {
      throw new Error('Received SKILL.md metadata does not match the authenticated manifest');
    }
  }

  async cleanup(): Promise<void> {
    this.closed = true;
    await rm(this.cleanupDir, { recursive: true, force: true });
  }
}

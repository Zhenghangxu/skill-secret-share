import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { createEngine } from '@secretlint/node';
import {
  createManifest,
  verifyManifest,
  type PackageManifest,
  type SkillMetadata,
} from '@skillspore/protocol';
import { parseDocument } from 'yaml';

export const PACKAGE_LIMITS = {
  totalBytes: 25 * 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
  files: 1_000,
  pathBytes: 240,
  depth: 20,
} as const;

const ALLOWED_FRONTMATTER = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXECUTABLE_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.exe',
  '.bat',
  '.cmd',
  '.ps1',
]);
const SUSPICIOUS_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i,
  /\.(?:pem|p12|pfx|key|keystore)$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.config\/gcloud\//i,
];

export interface SecretFinding {
  path: string;
  message: string;
  source: 'path' | 'secretlint';
}

export interface PreparedSkill {
  rootDir: string;
  metadata: SkillMetadata;
  manifest: PackageManifest;
  secretFindings: SecretFinding[];
}

export interface PreparedSkillSnapshot extends PreparedSkill {
  cleanup(): Promise<void>;
}

export function validateIncomingManifest(manifest: PackageManifest): void {
  if (!manifest || typeof manifest !== 'object' || !verifyManifest(manifest)) {
    throw new Error('Package manifest hash is invalid');
  }
  if (
    typeof manifest.transferId !== 'string' ||
    manifest.transferId.length < 1 ||
    manifest.transferId.length > 128
  ) {
    throw new Error('Package transfer ID is invalid');
  }
  if (
    !manifest.skill ||
    typeof manifest.skill.name !== 'string' ||
    !NAME_PATTERN.test(manifest.skill.name) ||
    manifest.skill.name.length > 64 ||
    typeof manifest.skill.description !== 'string' ||
    manifest.skill.description.length < 1 ||
    manifest.skill.description.length > 1024
  ) {
    throw new Error('Package skill metadata is invalid');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length > PACKAGE_LIMITS.files) {
    throw new Error('Package contains too many files');
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(file.path) ||
      /\p{Cf}/u.test(file.path) ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      Buffer.byteLength(file.path) > PACKAGE_LIMITS.pathBytes ||
      file.path.split('/').length > PACKAGE_LIMITS.depth ||
      paths.has(file.path)
    ) {
      throw new Error(`Package contains an unsafe or duplicate path: ${String(file?.path)}`);
    }
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > PACKAGE_LIMITS.fileBytes ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.executable !== 'boolean'
    ) {
      throw new Error(`Package file metadata is invalid: ${file.path}`);
    }
    paths.add(file.path);
    totalBytes += file.size;
    if (totalBytes > PACKAGE_LIMITS.totalBytes) throw new Error('Package exceeds the 25 MiB limit');
  }
  if (totalBytes !== manifest.totalBytes)
    throw new Error('Package byte count does not match its files');
  if (!paths.has('SKILL.md')) throw new Error('Package must include SKILL.md');
}

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith('---')) throw new Error('SKILL.md must begin with YAML frontmatter');
  const end = content.indexOf('\n---', 3);
  if (end < 0) throw new Error('SKILL.md frontmatter is not terminated');
  const document = parseDocument(content.slice(3, end));
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
  const data = document.toJS();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('SKILL.md frontmatter must be a mapping');
  }
  return data as Record<string, unknown>;
}

export async function validateSkill(rootDir: string): Promise<SkillMetadata> {
  const absoluteRoot = resolve(rootDir);
  const skillFile = join(absoluteRoot, 'SKILL.md');
  const content = await readFile(skillFile, 'utf8').catch(() => {
    throw new Error('Skill directory must contain SKILL.md');
  });
  const data = parseFrontmatter(content);
  for (const key of Object.keys(data)) {
    if (!ALLOWED_FRONTMATTER.has(key)) throw new Error(`Unsupported SKILL.md field: ${key}`);
  }
  if (typeof data.name !== 'string' || !NAME_PATTERN.test(data.name) || data.name.length > 64) {
    throw new Error('Skill name must be 1-64 lowercase letters, digits, and single hyphens');
  }
  if (data.name !== basename(absoluteRoot)) {
    throw new Error(`Skill name must match its directory name (${basename(absoluteRoot)})`);
  }
  if (
    typeof data.description !== 'string' ||
    data.description.trim().length === 0 ||
    data.description.length > 1024
  ) {
    throw new Error('Skill description must be 1-1024 characters');
  }
  if (data.license !== undefined && typeof data.license !== 'string') {
    throw new Error('Skill license must be a string');
  }
  if (
    data.compatibility !== undefined &&
    (typeof data.compatibility !== 'string' || data.compatibility.length > 500)
  ) {
    throw new Error('Skill compatibility must be a string of at most 500 characters');
  }
  if (data['allowed-tools'] !== undefined && typeof data['allowed-tools'] !== 'string') {
    throw new Error('Skill allowed-tools must be a space-separated string');
  }
  let metadata: Record<string, string> | undefined;
  if (data.metadata !== undefined) {
    if (!data.metadata || typeof data.metadata !== 'object' || Array.isArray(data.metadata)) {
      throw new Error('Skill metadata must be a string-to-string mapping');
    }
    metadata = {};
    for (const [key, value] of Object.entries(data.metadata as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`Skill metadata.${key} must be a string`);
      metadata[key] = value;
    }
  }
  return {
    name: data.name,
    description: data.description.trim(),
    ...(data.license === undefined ? {} : { license: data.license }),
    ...(data.compatibility === undefined ? {} : { compatibility: data.compatibility }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(data['allowed-tools'] === undefined ? {} : { allowedTools: data['allowed-tools'] }),
  };
}

interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  executable: boolean;
}

function isWithin(base: string, target: string): boolean {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + sep);
}

async function walkFiles(rootDir: string): Promise<WalkedFile[]> {
  const root = resolve(rootDir);
  const files: WalkedFile[] = [];
  let totalBytes = 0;

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > PACKAGE_LIMITS.depth) throw new Error('Skill directory is nested too deeply');
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink())
        throw new Error(`Symlinks are not allowed: ${relative(root, absolutePath)}`);
      if (stats.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!stats.isFile())
        throw new Error(`Special files are not allowed: ${relative(root, absolutePath)}`);
      if (!isWithin(root, absolutePath)) throw new Error('Skill path escapes its root directory');
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
        throw new Error(`Unsafe skill path: ${relativePath}`);
      }
      if (/[\u0000-\u001f\u007f]/.test(relativePath) || /\p{Cf}/u.test(relativePath)) {
        throw new Error(`Skill path contains control characters: ${relativePath}`);
      }
      if (Buffer.byteLength(relativePath) > PACKAGE_LIMITS.pathBytes) {
        throw new Error(`Skill path is too long: ${relativePath}`);
      }
      if (stats.size > PACKAGE_LIMITS.fileBytes)
        throw new Error(`Skill file is too large: ${relativePath}`);
      totalBytes += stats.size;
      if (totalBytes > PACKAGE_LIMITS.totalBytes)
        throw new Error('Skill exceeds the 25 MiB package limit');
      files.push({
        absolutePath,
        relativePath,
        size: stats.size,
        executable:
          (stats.mode & 0o111) !== 0 ||
          EXECUTABLE_EXTENSIONS.has(
            relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase()
          ),
      });
      if (files.length > PACKAGE_LIMITS.files)
        throw new Error('Skill contains more than 1,000 files');
    }
  }

  await visit(root, 0);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

async function runSecretlint(files: WalkedFile[]): Promise<SecretFinding[]> {
  if (files.length === 0) return [];
  const configDir = await mkdtemp(join(tmpdir(), 'skillspore-secretlint-'));
  try {
    await writeFile(
      join(configDir, '.secretlintrc.json'),
      JSON.stringify({ rules: [{ id: '@secretlint/secretlint-rule-preset-recommend' }] })
    );
    const engine = await createEngine({ cwd: configDir, color: false, formatter: 'compact' });
    const result = await engine.executeOnFiles({
      filePathList: files.map((file) => file.absolutePath),
    });
    if (!result.output.trim()) return [];
    return [{ path: 'multiple files', message: result.output.trim(), source: 'secretlint' }];
  } catch (error) {
    return [
      {
        path: 'secret scan',
        message: `Secretlint could not complete: ${error instanceof Error ? error.message : String(error)}`,
        source: 'secretlint',
      },
    ];
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

export async function prepareSkill(rootDir: string): Promise<PreparedSkill> {
  const absoluteRoot = resolve(rootDir);
  const metadata = await validateSkill(absoluteRoot);
  const files = await walkFiles(absoluteRoot);
  const manifestFiles = await Promise.all(
    files.map(async (file) => ({
      path: file.relativePath,
      size: file.size,
      sha256: createHash('sha256')
        .update(await readFile(file.absolutePath))
        .digest('hex'),
      executable: file.executable,
    }))
  );
  const pathFindings: SecretFinding[] = files
    .filter((file) => SUSPICIOUS_PATHS.some((pattern) => pattern.test(file.relativePath)))
    .map((file) => ({
      path: file.relativePath,
      message: 'Filename commonly contains credentials or private configuration',
      source: 'path' as const,
    }));
  const secretFindings = [...pathFindings, ...(await runSecretlint(files))];
  return {
    rootDir: absoluteRoot,
    metadata,
    manifest: createManifest({ skill: metadata, files: manifestFiles }),
    secretFindings,
  };
}

export async function prepareSkillSnapshot(rootDir: string): Promise<PreparedSkillSnapshot> {
  const sourceRoot = resolve(rootDir);
  const stagingDirectory = await mkdtemp(join(tmpdir(), 'skillspore-share-'));
  const snapshotRoot = join(stagingDirectory, basename(sourceRoot));
  try {
    await cp(sourceRoot, snapshotRoot, {
      recursive: true,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const prepared = await prepareSkill(snapshotRoot);
    return {
      ...prepared,
      cleanup: () => rm(stagingDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function resolveManifestPath(rootDir: string, relativePath: string): string {
  const target = resolve(rootDir, ...relativePath.split('/'));
  if (!isWithin(rootDir, target)) throw new Error(`Unsafe manifest path: ${relativePath}`);
  return target;
}

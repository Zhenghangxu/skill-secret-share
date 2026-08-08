import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'upstream-agents.json');
const destination = join(root, 'packages/installer/src/upstream');
const checkOnly = process.argv.includes('--check');
const refIndex = process.argv.indexOf('--ref');
const requestedRef = refIndex >= 0 ? process.argv[refIndex + 1] : undefined;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  repository: string;
  commit: string;
  files: Record<string, string>;
};
const ref = requestedRef ?? (checkOnly ? 'main' : manifest.commit);
const checkout = await mkdtemp(join(tmpdir(), 'skillspore-upstream-'));

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: checkout,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

try {
  git('init', '--quiet');
  git('remote', 'add', 'origin', manifest.repository);
  git('fetch', '--quiet', '--depth=1', 'origin', ref);
  git('checkout', '--quiet', 'FETCH_HEAD');
  const commit = git('rev-parse', 'HEAD');
  const nextFiles: Record<string, string> = {};
  for (const path of Object.keys(manifest.files)) {
    nextFiles[path] = hash(await readFile(join(checkout, path)));
  }

  if (checkOnly) {
    const changed = Object.entries(nextFiles).filter(
      ([path, digest]) => manifest.files[path] !== digest
    );
    if (changed.length === 0) {
      console.log(`Upstream agent registry is unchanged at ${commit}`);
    } else {
      console.error(`Upstream agent registry changed at ${commit}:`);
      for (const [path, digest] of changed) {
        console.error(`  ${path}: ${manifest.files[path]} -> ${digest}`);
      }
      process.exitCode = 1;
    }
  } else {
    for (const path of Object.keys(manifest.files)) {
      await cp(join(checkout, path), join(destination, path.replace(/^src\//, '')));
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify({ repository: manifest.repository, commit, files: nextFiles }, null, 2)}\n`
    );
    console.log(`Pinned upstream agent registry to ${commit}`);
  }
} finally {
  await rm(checkout, { recursive: true, force: true });
}

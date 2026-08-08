import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';

export interface SkillDiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'modified';
  patch?: string;
  oldSize?: number;
  newSize?: number;
}

async function collect(
  root: string
): Promise<Map<string, { path: string; size: number; hash: string }>> {
  const result = new Map<string, { path: string; size: number; hash: string }>();
  const resolvedRoot = await realpath(root).catch(() => root);
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const stats = await lstat(absolute);
      if (stats.isDirectory()) await walk(absolute);
      else if (stats.isFile()) {
        const path = relative(resolvedRoot, absolute).split(sep).join('/');
        result.set(path, {
          path: absolute,
          size: stats.size,
          hash: createHash('sha256')
            .update(await readFile(absolute))
            .digest('hex'),
        });
      }
    }
  }
  await walk(resolvedRoot);
  return result;
}

function isText(buffer: Buffer): boolean {
  return buffer.length <= 1024 * 1024 && !buffer.subarray(0, 8192).includes(0);
}

export async function diffSkillDirectories(
  existing: string,
  incoming: string
): Promise<SkillDiffEntry[]> {
  const [oldFiles, newFiles] = await Promise.all([collect(existing), collect(incoming)]);
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const changes: SkillDiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const oldFile = oldFiles.get(path);
    const newFile = newFiles.get(path);
    if (!oldFile) {
      changes.push({ path, kind: 'added', newSize: newFile!.size });
      continue;
    }
    if (!newFile) {
      changes.push({ path, kind: 'removed', oldSize: oldFile.size });
      continue;
    }
    if (oldFile.hash === newFile.hash) continue;
    const [oldBuffer, newBuffer] = await Promise.all([
      readFile(oldFile.path),
      readFile(newFile.path),
    ]);
    changes.push({
      path,
      kind: 'modified',
      oldSize: oldFile.size,
      newSize: newFile.size,
      ...(isText(oldBuffer) && isText(newBuffer)
        ? {
            patch: createTwoFilesPatch(
              `existing/${path}`,
              `incoming/${path}`,
              oldBuffer.toString('utf8'),
              newBuffer.toString('utf8'),
              '',
              '',
              { context: 3 }
            ),
          }
        : {}),
    });
  }
  return changes;
}

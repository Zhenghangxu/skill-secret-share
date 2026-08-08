import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  AGENTS,
  getAgentSkillsDir,
  getCanonicalSkillsDir,
  type AgentId,
  type InstallMode,
  type InstallScope,
} from './agents.js';

type OperationKind = 'copy' | 'symlink';

interface InstallOperation {
  kind: OperationKind;
  finalPath: string;
  stagePath: string;
  backupPath: string;
  sourcePath?: string;
  linkTarget?: string;
  hadExisting: boolean;
  committed: boolean;
}

interface Journal {
  id: string;
  cwd: string;
  scope: InstallScope;
  phase: 'staging' | 'committing';
  operations: InstallOperation[];
}

export interface InstallRequest {
  sourceDir: string;
  skillName: string;
  agents: AgentId[];
  scope: InstallScope;
  mode: InstallMode;
  cwd?: string;
  /** @internal Test-only fault injection after N committed filesystem operations. */
  testFaultAfterCommit?: number;
}

export interface InstallResult {
  paths: string[];
  mode: InstallMode;
}

export async function replaceDirectoryTransaction(
  sourceDir: string,
  targetDir: string
): Promise<void> {
  const id = randomUUID();
  const finalPath = resolve(targetDir);
  const parent = dirname(finalPath);
  const name = basename(finalPath);
  const stagePath = join(parent, `.skillspore-stage-${id}-${name}`);
  const backupPath = join(parent, `.skillspore-backup-${id}-${name}`);
  await mkdir(parent, { recursive: true });
  await cp(sourceDir, stagePath, { recursive: true, dereference: false, errorOnExist: true });
  const hadExisting = await pathExists(finalPath);
  try {
    if (hadExisting) await rename(finalPath, backupPath);
    await rename(stagePath, finalPath);
    await rm(backupPath, { recursive: true, force: true });
  } catch (error) {
    await rm(stagePath, { recursive: true, force: true });
    await rm(finalPath, { recursive: true, force: true });
    if (hadExisting && (await pathExists(backupPath))) await rename(backupPath, finalPath);
    throw error;
  }
}

const TRANSACTION_ROOT = join(tmpdir(), 'skillspore-transactions');

function isPathWithin(base: string, target: string): boolean {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + sep);
}

function allowedRoots(journal: Pick<Journal, 'cwd' | 'scope'>): string[] {
  return [
    getCanonicalSkillsDir(journal.scope, journal.cwd),
    ...(Object.keys(AGENTS) as AgentId[]).map((agent) =>
      getAgentSkillsDir(agent, journal.scope, journal.cwd)
    ),
  ].map((path) => resolve(path));
}

function validateOperation(journal: Journal, operation: InstallOperation): void {
  const roots = allowedRoots(journal);
  if (!roots.some((root) => isPathWithin(root, operation.finalPath))) {
    throw new Error(`Unsafe recovery path: ${operation.finalPath}`);
  }
  if (dirname(operation.stagePath) !== dirname(operation.finalPath)) {
    throw new Error('Transaction stage must be beside its final path');
  }
  if (dirname(operation.backupPath) !== dirname(operation.finalPath)) {
    throw new Error('Transaction backup must be beside its final path');
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

async function persist(journalPath: string, journal: Journal): Promise<void> {
  await writeFile(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
}

export async function recoverTransactions(): Promise<void> {
  await mkdir(TRANSACTION_ROOT, { recursive: true });
  for (const entry of await readdir(TRANSACTION_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(TRANSACTION_ROOT, entry.name);
    const journalPath = join(directory, 'journal.json');
    try {
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
      for (const operation of journal.operations) validateOperation(journal, operation);
      for (const operation of [...journal.operations].reverse()) {
        await rm(operation.stagePath, { recursive: true, force: true });
        if (operation.committed) await rm(operation.finalPath, { recursive: true, force: true });
        if (operation.hadExisting && (await pathExists(operation.backupPath))) {
          await rename(operation.backupPath, operation.finalPath);
        } else {
          await rm(operation.backupPath, { recursive: true, force: true });
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function createOperation(input: {
  kind: OperationKind;
  finalPath: string;
  id: string;
  sourcePath?: string;
  linkTarget?: string;
}): InstallOperation {
  const parent = dirname(input.finalPath);
  const name = basename(input.finalPath);
  return {
    kind: input.kind,
    finalPath: input.finalPath,
    stagePath: join(parent, `.skillspore-stage-${input.id}-${name}`),
    backupPath: join(parent, `.skillspore-backup-${input.id}-${name}`),
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    ...(input.linkTarget === undefined ? {} : { linkTarget: input.linkTarget }),
    hadExisting: false,
    committed: false,
  };
}

function buildOperations(request: InstallRequest, id: string): InstallOperation[] {
  const cwd = request.cwd ?? process.cwd();
  const canonical = join(getCanonicalSkillsDir(request.scope, cwd), request.skillName);
  if (request.mode === 'copy') {
    const uniquePaths = new Set(
      request.agents.map((agent) =>
        join(getAgentSkillsDir(agent, request.scope, cwd), request.skillName)
      )
    );
    return [...uniquePaths].map((finalPath) =>
      createOperation({ kind: 'copy', finalPath, sourcePath: request.sourceDir, id })
    );
  }
  const operations = [
    createOperation({ kind: 'copy', finalPath: canonical, sourcePath: request.sourceDir, id }),
  ];
  const uniqueAgentPaths = new Set(
    request.agents.map((agent) =>
      join(getAgentSkillsDir(agent, request.scope, cwd), request.skillName)
    )
  );
  for (const finalPath of uniqueAgentPaths) {
    if (resolve(finalPath) === resolve(canonical)) continue;
    operations.push(createOperation({ kind: 'symlink', finalPath, linkTarget: canonical, id }));
  }
  return operations;
}

export async function installSkillTransaction(request: InstallRequest): Promise<InstallResult> {
  if (request.agents.length === 0) throw new Error('Select at least one agent');
  await recoverTransactions();
  const id = randomUUID();
  const directory = await mkdtemp(join(TRANSACTION_ROOT, `${id}-`));
  const journalPath = join(directory, 'journal.json');
  const journal: Journal = {
    id,
    cwd: request.cwd ?? process.cwd(),
    scope: request.scope,
    phase: 'staging',
    operations: buildOperations(request, id),
  };
  for (const operation of journal.operations) validateOperation(journal, operation);
  await persist(journalPath, journal);

  try {
    let committedCount = 0;
    for (const operation of journal.operations) {
      await mkdir(dirname(operation.finalPath), { recursive: true });
      await rm(operation.stagePath, { recursive: true, force: true });
      if (operation.kind === 'copy') {
        await cp(operation.sourcePath!, operation.stagePath, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
        });
      } else {
        const target =
          process.platform === 'win32'
            ? operation.linkTarget!
            : relative(dirname(operation.finalPath), operation.linkTarget!);
        await symlink(
          target,
          operation.stagePath,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      }
    }

    journal.phase = 'committing';
    await persist(journalPath, journal);
    for (const operation of journal.operations) {
      operation.hadExisting = await pathExists(operation.finalPath);
      if (operation.hadExisting) await rename(operation.finalPath, operation.backupPath);
      await rename(operation.stagePath, operation.finalPath);
      operation.committed = true;
      committedCount++;
      await persist(journalPath, journal);
      if (request.testFaultAfterCommit === committedCount) {
        throw new Error('Injected transaction failure');
      }
    }
    for (const operation of journal.operations) {
      await rm(operation.backupPath, { recursive: true, force: true });
    }
    await rm(directory, { recursive: true, force: true });
    return {
      paths: journal.operations.map((operation) => operation.finalPath),
      mode: request.mode,
    };
  } catch (error) {
    for (const operation of [...journal.operations].reverse()) {
      await rm(operation.stagePath, { recursive: true, force: true });
      if (operation.committed) await rm(operation.finalPath, { recursive: true, force: true });
      if (operation.hadExisting && (await pathExists(operation.backupPath))) {
        await rename(operation.backupPath, operation.finalPath);
      }
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

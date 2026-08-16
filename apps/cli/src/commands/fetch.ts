import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { normalizePasscode } from '../../../../packages/protocol/src/index.js';
import {
  AGENTS,
  detectInstalledAgents,
  diffSkillDirectories,
  getAgentSkillsDir,
  getCanonicalSkillsDir,
  installSkillTransaction,
  prepareSkill,
  replaceDirectoryTransaction,
  resolveManifestPath,
  type AgentId,
  type InstallMode,
  type InstallScope,
  type PreparedSkill,
} from '../../../../packages/installer/src/index.js';
import { receiveDirectoryWithCroc } from '../../../../packages/transport/src/index.js';
import { crocRelay, getOption, hasOption } from '../options.js';
import { assertNotCancelled, printDiff, printManifest, printSecretFindings } from '../ui.js';

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

async function inspectReceivedSkill(receiveRoot: string): Promise<PreparedSkill> {
  const entries = await readdir(receiveRoot, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]!.isDirectory()) {
    throw new Error('The transfer must contain exactly one skill directory');
  }
  const prepared = await prepareSkill(join(receiveRoot, entries[0]!.name));
  await chmod(prepared.rootDir, 0o700).catch(() => undefined);
  await Promise.all(
    prepared.manifest.files.map((file) =>
      chmod(
        resolveManifestPath(prepared.rootDir, file.path),
        file.executable ? 0o700 : 0o600
      ).catch(() => undefined)
    )
  );
  return prepared;
}

async function chooseAgents(): Promise<AgentId[]> {
  const detected = await detectInstalledAgents();
  const selected = assertNotCancelled(
    await p.multiselect({
      message: 'Install for which agents?',
      options: (Object.keys(AGENTS) as AgentId[]).map((agent) => ({
        value: agent,
        label: AGENTS[agent].displayName,
        ...(detected.includes(agent) ? { hint: 'detected' } : {}),
      })),
      initialValues: detected.length > 0 ? detected : ['codex'],
      required: true,
    }),
    'Installation cancelled'
  );
  return selected as AgentId[];
}

async function reviewOverwrite(
  sourceDir: string,
  skillName: string,
  agents: AgentId[],
  scope: InstallScope,
  mode: InstallMode
): Promise<void> {
  const candidates = new Set<string>();
  if (mode === 'symlink') candidates.add(resolve(getCanonicalSkillsDir(scope), skillName));
  for (const agent of agents) candidates.add(resolve(getAgentSkillsDir(agent, scope), skillName));
  for (const path of candidates) {
    if (!(await exists(path))) continue;
    printDiff(await diffSkillDirectories(path, sourceDir));
    const overwrite = assertNotCancelled(
      await p.confirm({ message: `Overwrite existing ${skillName}?`, initialValue: false }),
      'Installation cancelled'
    );
    if (!overwrite) throw new Error('Installation cancelled');
    return;
  }
}

export async function runFetch(args: string[]): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' SkillSpore fetch ')));
  const passcodeInput = assertNotCancelled(
    await p.password({ message: 'Passcode', mask: '*' }),
    'Fetch cancelled'
  );
  const code = normalizePasscode(passcodeInput);
  const receiveRoot = await mkdtemp(join(tmpdir(), 'skillspore-receive-'));
  try {
    p.note(
      "Review croc's file count and total size before accepting the transfer.",
      'Incoming skill'
    );
    const relay = crocRelay(args);
    await receiveDirectoryWithCroc(receiveRoot, code, relay ? { relay } : {});

    const spinner = p.spinner();
    spinner.start('Validating and scanning received skill');
    let prepared: PreparedSkill;
    try {
      prepared = await inspectReceivedSkill(receiveRoot);
    } catch (error) {
      spinner.stop('Received skill was rejected');
      throw error;
    }
    spinner.stop('Received skill is valid');
    printManifest(prepared.manifest);
    printSecretFindings(prepared.secretFindings);

    if (hasOption(args, '--download-only')) {
      const output = resolve(getOption(args, '--output') ?? prepared.metadata.name);
      if (await exists(output)) {
        printDiff(await diffSkillDirectories(output, prepared.rootDir));
        const overwrite = assertNotCancelled(
          await p.confirm({ message: `Replace ${output}?`, initialValue: false }),
          'Download cancelled'
        );
        if (!overwrite) throw new Error('Download cancelled');
      }
      await replaceDirectoryTransaction(prepared.rootDir, output);
      p.outro(pc.green(`Downloaded ${prepared.metadata.name} to ${output}`));
      return;
    }

    const agents = await chooseAgents();
    const scope = assertNotCancelled(
      await p.select({
        message: 'Installation scope',
        options: [
          { value: 'project', label: 'Project', hint: 'Current project' },
          { value: 'global', label: 'Global', hint: 'Available in every project' },
        ],
      }),
      'Installation cancelled'
    ) as InstallScope;
    const mode = assertNotCancelled(
      await p.select({
        message: 'Installation method',
        options: [
          { value: 'symlink', label: 'Symlink', hint: 'Single canonical copy' },
          { value: 'copy', label: 'Copy', hint: 'Independent copies' },
        ],
      }),
      'Installation cancelled'
    ) as InstallMode;
    await reviewOverwrite(prepared.rootDir, prepared.metadata.name, agents, scope, mode);
    const confirmed = assertNotCancelled(
      await p.confirm({ message: `Install ${prepared.metadata.name}?`, initialValue: true }),
      'Installation cancelled'
    );
    if (!confirmed) throw new Error('Installation cancelled');
    spinner.start('Installing skill atomically');
    const result = await installSkillTransaction({
      sourceDir: prepared.rootDir,
      skillName: prepared.metadata.name,
      agents,
      scope,
      mode,
    });
    spinner.stop('Installation complete');
    p.note(result.paths.join('\n'), 'Installed paths');
    p.outro(pc.green(`Installed ${prepared.metadata.name} successfully.`));
  } finally {
    await rm(receiveRoot, { recursive: true, force: true });
  }
}

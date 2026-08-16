import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  createReceiptMac,
  decodeFileFrame,
  parsePasscode,
  type PackageManifest,
} from '../../../../packages/protocol/src/index.js';
import {
  AGENTS,
  QuarantineWriter,
  detectInstalledAgents,
  diffSkillDirectories,
  getAgentSkillsDir,
  getCanonicalSkillsDir,
  installSkillTransaction,
  replaceDirectoryTransaction,
  type AgentId,
  type InstallMode,
  type InstallScope,
} from '../../../../packages/installer/src/index.js';
import {
  connectSecurePeer,
  joinRendezvousSession,
} from '../../../../packages/transport/src/index.js';
import { getOption, hasOption, iceTransportPolicy, serverUrl } from '../options.js';
import { assertNotCancelled, printDiff, printManifest } from '../ui.js';

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

async function receivePackage(
  peer: Awaited<ReturnType<typeof connectSecurePeer>>,
  manifest: PackageManifest
): Promise<QuarantineWriter> {
  const quarantine = await QuarantineWriter.create(manifest);
  try {
    peer.session.sendControl({ type: 'accept-transfer' });
    for (let fileIndex = 0; fileIndex < manifest.files.length; fileIndex++) {
      const file = manifest.files[fileIndex]!;
      let received = 0;
      while (received < file.size) {
        const encoded = await peer.session.receiveFileFrame(5 * 60 * 1000);
        const frame = decodeFileFrame(encoded);
        if (frame.fileIndex !== fileIndex)
          throw new Error(`Unexpected file frame for ${file.path}`);
        await quarantine.writeFrame(encoded);
        received += frame.data.length;
      }
      const complete = await peer.session.receiveControl(5 * 60 * 1000);
      if (complete.type !== 'file-complete' || complete.fileIndex !== fileIndex) {
        throw new Error(`Missing completion marker for ${file.path}`);
      }
    }
    const complete = await peer.session.receiveControl(5 * 60 * 1000);
    if (complete.type !== 'transfer-complete') throw new Error('Transfer ended unexpectedly');
    await quarantine.verify();
    return quarantine;
  } catch (error) {
    await quarantine.cleanup();
    throw error;
  }
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
  const { nameplate, secret } = parsePasscode(passcodeInput);
  const spinner = p.spinner();
  spinner.start('Joining sender');
  const openSession = await joinRendezvousSession(serverUrl(args), nameplate);
  spinner.stop('Connected to sender');
  let peer: Awaited<ReturnType<typeof connectSecurePeer>> | undefined;
  let quarantine: QuarantineWriter | undefined;
  try {
    spinner.start('Authenticating sender');
    peer = await connectSecurePeer({
      openSession,
      secret,
      role: 'receiver',
      iceTransportPolicy: iceTransportPolicy(args),
    });
    spinner.stop(`Sender authenticated (${peer.session.connectionType})`);
    const first = await peer.session.receiveControl(60_000);
    if (first.type !== 'manifest') throw new Error('Sender did not provide a package manifest');
    printManifest(first.manifest);
    const accepted = assertNotCancelled(
      await p.confirm({ message: 'Receive this skill?', initialValue: true }),
      'Fetch cancelled'
    );
    if (!accepted) {
      peer.session.sendControl({ type: 'reject-transfer', reason: 'Receiver declined' });
      throw new Error('Fetch cancelled');
    }
    spinner.start('Receiving and verifying skill');
    quarantine = await receivePackage(peer, first.manifest);
    spinner.stop('Skill transfer verified');
    const receipt = {
      packageHash: first.manifest.packageHash,
      totalBytes: first.manifest.totalBytes,
      transferId: first.manifest.transferId,
    };
    peer.session.sendControl({
      type: 'receipt',
      ...receipt,
      mac: createReceiptMac(peer.keys.receiptKey, receipt),
    });
    const acknowledgement = await peer.session.receiveControl(30_000);
    if (acknowledgement.type !== 'receipt-ack')
      throw new Error('Sender did not acknowledge the receipt');
    openSession.rendezvous.markComplete();
    peer.session.close();
    peer = undefined;

    if (hasOption(args, '--download-only')) {
      const output = resolve(getOption(args, '--output') ?? first.manifest.skill.name);
      if (await exists(output)) {
        printDiff(await diffSkillDirectories(output, quarantine.rootDir));
        const overwrite = assertNotCancelled(
          await p.confirm({ message: `Replace ${output}?`, initialValue: false }),
          'Download cancelled'
        );
        if (!overwrite) throw new Error('Download cancelled');
      }
      await replaceDirectoryTransaction(quarantine.rootDir, output);
      p.outro(pc.green(`Downloaded ${first.manifest.skill.name} to ${output}`));
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
    await reviewOverwrite(quarantine.rootDir, first.manifest.skill.name, agents, scope, mode);
    const confirmed = assertNotCancelled(
      await p.confirm({ message: `Install ${first.manifest.skill.name}?`, initialValue: true }),
      'Installation cancelled'
    );
    if (!confirmed) throw new Error('Installation cancelled');
    spinner.start('Installing skill atomically');
    const result = await installSkillTransaction({
      sourceDir: quarantine.rootDir,
      skillName: first.manifest.skill.name,
      agents,
      scope,
      mode,
    });
    spinner.stop('Installation complete');
    p.note(result.paths.join('\n'), 'Installed paths');
    p.outro(pc.green(`Installed ${first.manifest.skill.name} successfully.`));
  } finally {
    peer?.session.close();
    openSession.rendezvous.close();
    await quarantine?.cleanup();
  }
}

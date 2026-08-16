import { open } from 'node:fs/promises';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  FILE_CHUNK_BYTES,
  encodeFileFrame,
  formatPasscode,
  generateSecretPhrase,
  validateCustomSecret,
  verifyReceiptMac,
} from '../../../../packages/protocol/src/index.js';
import { prepareSkill, resolveManifestPath } from '../../../../packages/installer/src/index.js';
import {
  connectSecurePeer,
  createRendezvousSession,
} from '../../../../packages/transport/src/index.js';
import { hasOption, iceTransportPolicy, positionalArgs, serverUrl } from '../options.js';
import { assertNotCancelled, printManifest, printSecretFindings } from '../ui.js';

async function promptCustomSecret(): Promise<string> {
  const first = assertNotCancelled(
    await p.password({ message: 'Custom secret phrase', mask: '*' }),
    'Sharing cancelled'
  );
  const second = assertNotCancelled(
    await p.password({ message: 'Repeat secret phrase', mask: '*' }),
    'Sharing cancelled'
  );
  if (first !== second) throw new Error('Custom secret phrases do not match');
  return validateCustomSecret(first);
}

export async function runShare(args: string[]): Promise<void> {
  const [directory] = positionalArgs(args, ['--server']);
  if (!directory) throw new Error('Usage: skillspore share <skill-directory>');
  p.intro(pc.bgGreen(pc.black(' SkillSpore share ')));
  const spinner = p.spinner();
  spinner.start('Validating and scanning skill');
  const prepared = await prepareSkill(directory);
  spinner.stop('Skill is ready to share');
  printManifest(prepared.manifest);
  printSecretFindings(prepared.secretFindings);
  if (prepared.secretFindings.length > 0) {
    const confirmed = assertNotCancelled(
      await p.confirm({
        message: 'Share despite these best-effort secret warnings?',
        initialValue: false,
      }),
      'Sharing cancelled'
    );
    if (!confirmed) throw new Error('Sharing cancelled');
  }

  const secret = hasOption(args, '--custom-passcode')
    ? await promptCustomSecret()
    : generateSecretPhrase();
  spinner.start('Creating one-time session');
  const openSession = await createRendezvousSession(serverUrl(args));
  spinner.stop('One-time session created');
  const passcode = formatPasscode(openSession.info.nameplate, secret);
  p.note(
    `${pc.bold(passcode)}\n\nWaiting for one receiver. Do not close this terminal.`,
    'Passcode'
  );

  let peer: Awaited<ReturnType<typeof connectSecurePeer>> | undefined;
  try {
    spinner.start('Authenticating receiver');
    peer = await connectSecurePeer({
      openSession,
      secret,
      role: 'sender',
      iceTransportPolicy: iceTransportPolicy(args),
    });
    spinner.stop(`Receiver authenticated (${peer.session.connectionType})`);
    peer.session.sendControl({ type: 'manifest', manifest: prepared.manifest });
    const decision = await peer.session.receiveControl(5 * 60 * 1000);
    if (decision.type !== 'accept-transfer') {
      throw new Error(
        decision.type === 'reject-transfer'
          ? 'Receiver declined the transfer'
          : 'Unexpected receiver response'
      );
    }

    spinner.start('Transferring skill');
    for (let fileIndex = 0; fileIndex < prepared.manifest.files.length; fileIndex++) {
      const file = prepared.manifest.files[fileIndex]!;
      const source = resolveManifestPath(prepared.rootDir, file.path);
      const handle = await open(source, 'r');
      try {
        let offset = 0;
        while (offset < file.size) {
          const buffer = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, file.size - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (bytesRead === 0) throw new Error(`Unexpected end of file: ${file.path}`);
          await peer.session.sendFileFrame(
            encodeFileFrame({ fileIndex, offset, data: buffer.subarray(0, bytesRead) })
          );
          offset += bytesRead;
        }
      } finally {
        await handle.close();
      }
      peer.session.sendControl({ type: 'file-complete', fileIndex });
    }
    peer.session.sendControl({ type: 'transfer-complete' });
    const receipt = await peer.session.receiveControl(5 * 60 * 1000);
    if (receipt.type !== 'receipt') throw new Error('Receiver did not provide a transfer receipt');
    const receiptData = {
      packageHash: receipt.packageHash,
      totalBytes: receipt.totalBytes,
      transferId: receipt.transferId,
    };
    if (
      receipt.packageHash !== prepared.manifest.packageHash ||
      receipt.totalBytes !== prepared.manifest.totalBytes ||
      receipt.transferId !== prepared.manifest.transferId ||
      !verifyReceiptMac(peer.keys.receiptKey, receiptData, receipt.mac)
    ) {
      throw new Error('Receiver receipt could not be authenticated');
    }
    peer.session.sendControl({ type: 'receipt-ack' });
    spinner.stop('Transfer verified by receiver');
    openSession.rendezvous.markComplete();
    p.outro(pc.green(`Transferred ${prepared.metadata.name} successfully.`));
  } finally {
    peer?.session.close();
    openSession.rendezvous.close();
  }
}

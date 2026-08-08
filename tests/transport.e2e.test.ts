import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createManifest,
  createReceiptMac,
  encodeFileFrame,
  sha256Hex,
  verifyReceiptMac,
} from '../packages/protocol/src/index.js';
import { QuarantineWriter } from '../packages/installer/src/index.js';
import {
  connectSecurePeer,
  createRendezvousSession,
  joinRendezvousSession,
  RendezvousClient,
} from '../packages/transport/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let serverProcess: ChildProcess;
let serverUrl: string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

beforeAll(async () => {
  const port = await freePort();
  serverUrl = `ws://127.0.0.1:${port}/v1/rendezvous`;
  serverProcess = spawn(
    process.execPath,
    [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'apps/rendezvous/src/server.ts')],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        SKILLSPORE_ICE_SERVERS_JSON: '[]',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Rendezvous server did not start')), 10_000);
    serverProcess.stdout!.on('data', (chunk) => {
      if (!chunk.toString().includes('SkillSpore rendezvous listening')) return;
      clearTimeout(timeout);
      resolveReady();
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Rendezvous server exited early with ${code}: ${serverProcess.stderr?.read() ?? ''}`
        )
      );
    });
  });
});

afterAll(async () => {
  if (!serverProcess?.killed) serverProcess.kill('SIGTERM');
  await new Promise((resolveExit) => serverProcess?.once('exit', resolveExit));
});

describe('local end-to-end secure transport', () => {
  it('allows exactly one receiver per live session', async () => {
    const sender = await createRendezvousSession(serverUrl);
    const receiver = await joinRendezvousSession(serverUrl, sender.info.nameplate);
    const intruder = await RendezvousClient.connect(serverUrl);
    try {
      await expect(intruder.join(sender.info.nameplate)).rejects.toThrow(/occupied/);
    } finally {
      intruder.close();
      receiver.rendezvous.close();
      sender.rendezvous.close();
    }
  });

  it('pairs two clients, authenticates the passcode and DTLS fingerprints, and transfers control data', async () => {
    const senderOpen = await createRendezvousSession(serverUrl);
    const receiverOpen = await joinRendezvousSession(serverUrl, senderOpen.info.nameplate);
    const secret = 'alpha-beta-gamma';
    const [sender, receiver] = await Promise.all([
      connectSecurePeer({ openSession: senderOpen, secret, role: 'sender' }),
      connectSecurePeer({ openSession: receiverOpen, secret, role: 'receiver' }),
    ]);
    try {
      const largeControlMessage = { type: 'cancel' as const, reason: 'x'.repeat(200_000) };
      sender.session.sendControl(largeControlMessage);
      await expect(receiver.session.receiveControl()).resolves.toEqual(largeControlMessage);
      const contents = new Map([
        [
          'SKILL.md',
          Buffer.from('---\nname: example-skill\ndescription: E2E test\n---\n\n# Example\n'),
        ],
        ['content.txt', Buffer.from('hello peer\n')],
      ]);
      const manifest = createManifest({
        transferId: 'e2e-transfer',
        skill: { name: 'example-skill', description: 'E2E test' },
        files: [
          {
            path: 'SKILL.md',
            size: contents.get('SKILL.md')!.length,
            sha256: sha256Hex(contents.get('SKILL.md')!),
            executable: false,
          },
          {
            path: 'content.txt',
            size: contents.get('content.txt')!.length,
            sha256: sha256Hex(contents.get('content.txt')!),
            executable: false,
          },
        ],
      });
      sender.session.sendControl({ type: 'manifest', manifest });
      await expect(receiver.session.receiveControl()).resolves.toEqual({
        type: 'manifest',
        manifest,
      });
      const quarantine = await QuarantineWriter.create(manifest);
      try {
        receiver.session.sendControl({ type: 'accept-transfer' });
        await expect(sender.session.receiveControl()).resolves.toEqual({ type: 'accept-transfer' });
        for (let index = 0; index < manifest.files.length; index++) {
          const data = contents.get(manifest.files[index]!.path)!;
          await sender.session.sendFileFrame(
            encodeFileFrame({ fileIndex: index, offset: 0, data })
          );
          sender.session.sendControl({ type: 'file-complete', fileIndex: index });
          await quarantine.writeFrame(await receiver.session.receiveFileFrame());
          await expect(receiver.session.receiveControl()).resolves.toEqual({
            type: 'file-complete',
            fileIndex: index,
          });
        }
        sender.session.sendControl({ type: 'transfer-complete' });
        await expect(receiver.session.receiveControl()).resolves.toEqual({
          type: 'transfer-complete',
        });
        await quarantine.verify();
        const receipt = {
          packageHash: manifest.packageHash,
          totalBytes: manifest.totalBytes,
          transferId: manifest.transferId,
        };
        receiver.session.sendControl({
          type: 'receipt',
          ...receipt,
          mac: createReceiptMac(receiver.keys.receiptKey, receipt),
        });
        const receivedReceipt = await sender.session.receiveControl();
        expect(receivedReceipt.type).toBe('receipt');
        if (receivedReceipt.type === 'receipt') {
          expect(verifyReceiptMac(sender.keys.receiptKey, receipt, receivedReceipt.mac)).toBe(true);
        }
        sender.session.sendControl({ type: 'receipt-ack' });
        await expect(receiver.session.receiveControl()).resolves.toEqual({ type: 'receipt-ack' });
      } finally {
        await quarantine.cleanup();
      }
      expect(sender.session.connectionType).toBe('direct');
      expect(receiver.session.connectionType).toBe('direct');
    } finally {
      sender.session.close();
      receiver.session.close();
      senderOpen.rendezvous.close();
      receiverOpen.rendezvous.close();
    }
  });
});

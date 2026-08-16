import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  beginPake,
  computePackageHash,
  createBindingMac,
  createManifest,
  createReceiptMac,
  decodeFileFrame,
  encodeFileFrame,
  finishPake,
  formatPasscode,
  generateSecretPhrase,
  parsePasscode,
  parseClientRendezvousJson,
  parseRendezvousSubprotocol,
  parseServerRendezvousJson,
  validateCustomSecret,
  verifyBindingMac,
  verifyManifest,
  verifyReceiptMac,
  type SessionBinding,
} from './index.js';

describe('passcodes', () => {
  it('generates and parses a three-word secret without exposing the secret as the nameplate', () => {
    const secret = generateSecretPhrase();
    expect(secret.split('-')).toHaveLength(3);
    const passcode = formatPasscode('0042', secret);
    expect(parsePasscode(passcode)).toEqual({ nameplate: '0042', secret });
  });

  it('enforces custom passcode strength', () => {
    expect(() => validateCustomSecret('short')).toThrow();
    expect(validateCustomSecret('three distinct words')).toBe('three-distinct-words');
  });
});

describe('rendezvous v1 schemas', () => {
  it('parses sender and receiver upgrade subprotocols', () => {
    expect(parseRendezvousSubprotocol('skillspore.v1.sender')).toEqual({
      protocol: 'skillspore.v1.sender',
      role: 'sender',
    });
    expect(parseRendezvousSubprotocol('skillspore.v1.receiver.0042')).toEqual({
      protocol: 'skillspore.v1.receiver.0042',
      role: 'receiver',
      nameplate: '0042',
    });
    expect(() => parseRendezvousSubprotocol('skillspore.v1.sender, other')).toThrow();
    expect(() => parseRendezvousSubprotocol('skillspore.v1.receiver.42')).toThrow();
  });

  it('accepts only the final rendezvous v1 messages', () => {
    expect(parseClientRendezvousJson('{"type":"complete"}')).toEqual({ type: 'complete' });
    expect(
      parseClientRendezvousJson(
        '{"type":"relay","payload":{"type":"candidate","candidate":"candidate","mid":"0"}}'
      )
    ).toEqual({
      type: 'relay',
      payload: { type: 'candidate', candidate: 'candidate', mid: '0' },
    });
    expect(() => parseClientRendezvousJson('{"type":"create"}')).toThrow();
    expect(() => parseClientRendezvousJson('{"type":"join","nameplate":"0042"}')).toThrow();
  });

  it('validates paired ICE configuration and retry metadata', () => {
    expect(
      parseServerRendezvousJson(
        '{"type":"paired","iceServers":[{"urls":"stun:stun.cloudflare.com:3478"}]}'
      )
    ).toEqual({
      type: 'paired',
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    });
    expect(
      parseServerRendezvousJson(
        '{"type":"error","code":"rate-limited","message":"Slow down","retryAfterMs":500}'
      )
    ).toEqual({
      type: 'error',
      code: 'rate-limited',
      message: 'Slow down',
      retryAfterMs: 500,
    });
  });

  it('rejects signaling messages larger than 64 KiB', () => {
    expect(() =>
      parseClientRendezvousJson(
        JSON.stringify({
          type: 'relay',
          payload: { type: 'pake-share', share: 'x'.repeat(70_000) },
        })
      )
    ).toThrow(/64 KiB/);
  });
});

describe('manifests and frames', () => {
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

  it('round-trips binary file frames and rejects inconsistent lengths', () => {
    const encoded = encodeFileFrame({ fileIndex: 3, offset: 12, data: Buffer.from('hello') });
    expect(decodeFileFrame(encoded)).toEqual({
      fileIndex: 3,
      offset: 12,
      data: Buffer.from('hello'),
    });
    expect(() => decodeFileFrame(encoded.subarray(0, -1))).toThrow();
  });
});

describe('PAKE and transcript authentication', () => {
  it('derives matching keys and binds roles, fingerprints, and receipts', async () => {
    const sid = Buffer.alloc(32, 7);
    const [sender, receiver] = await Promise.all([
      beginPake({ secret: 'alpha-beta-gamma', sid, role: 'sender' }),
      beginPake({ secret: 'alpha-beta-gamma', sid, role: 'receiver' }),
    ]);
    const senderKeys = finishPake(sender, receiver.share);
    const receiverKeys = finishPake(receiver, sender.share);
    expect(Buffer.from(senderKeys.confirmationKey)).toEqual(
      Buffer.from(receiverKeys.confirmationKey)
    );
    const binding: SessionBinding = {
      protocolVersion: PROTOCOL_VERSION,
      sid: sid.toString('base64url'),
      nameplate: '0042',
      initiatorFingerprint: { algorithm: 'sha-256', value: 'aa' },
      responderFingerprint: { algorithm: 'sha-256', value: 'bb' },
    };
    const senderMac = createBindingMac(senderKeys.confirmationKey, binding, 'sender');
    expect(verifyBindingMac(receiverKeys.confirmationKey, binding, 'sender', senderMac)).toBe(true);
    expect(verifyBindingMac(receiverKeys.confirmationKey, binding, 'receiver', senderMac)).toBe(
      false
    );
    const receipt = { packageHash: 'c'.repeat(64), totalBytes: 42, transferId: 'transfer' };
    const receiptMac = createReceiptMac(senderKeys.receiptKey, receipt);
    expect(verifyReceiptMac(receiverKeys.receiptKey, receipt, receiptMac)).toBe(true);
  });

  it('fails confirmation when peers use different passcodes', async () => {
    const sid = Buffer.alloc(32, 9);
    const [sender, receiver] = await Promise.all([
      beginPake({ secret: 'alpha-beta-gamma', sid, role: 'sender' }),
      beginPake({ secret: 'wrong-secret-phrase', sid, role: 'receiver' }),
    ]);
    const senderKeys = finishPake(sender, receiver.share);
    const receiverKeys = finishPake(receiver, sender.share);
    const binding: SessionBinding = {
      protocolVersion: PROTOCOL_VERSION,
      sid: sid.toString('base64url'),
      nameplate: '0042',
      initiatorFingerprint: { algorithm: 'sha-256', value: 'aa' },
      responderFingerprint: { algorithm: 'sha-256', value: 'bb' },
    };
    const mac = createBindingMac(senderKeys.confirmationKey, binding, 'sender');
    expect(verifyBindingMac(receiverKeys.confirmationKey, binding, 'sender', mac)).toBe(false);
  });
});

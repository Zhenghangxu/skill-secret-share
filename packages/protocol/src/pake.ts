import { createHash, createHmac, hkdfSync, scrypt, timingSafeEqual } from 'node:crypto';
import { cpace } from '@cipherman/pake-js';
import { canonicalJson } from './canonical.js';
import type { SessionBinding } from './types.js';

const textEncoder = new TextEncoder();
const CHANNEL_ID = textEncoder.encode('skillspore/webrtc-dtls/v1');

export interface PakeState {
  role: 'sender' | 'receiver';
  sid: Uint8Array;
  ephemeralSecret: Uint8Array;
  share: Uint8Array;
}

export interface SessionKeys {
  confirmationKey: Uint8Array;
  receiptKey: Uint8Array;
}

function scryptAsync(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(new Uint8Array(key));
    });
  });
}

async function derivePrs(secret: string, sid: Uint8Array): Promise<Uint8Array> {
  const salt = createHash('sha256').update('skillspore/cpace-prs/v1').update(sid).digest();
  return scryptAsync(secret, salt);
}

export async function beginPake(input: {
  secret: string;
  sid: Uint8Array;
  role: 'sender' | 'receiver';
}): Promise<PakeState> {
  const PRS = await derivePrs(input.secret, input.sid);
  const initialized = cpace.ristretto255.init({ PRS, sid: input.sid, CI: CHANNEL_ID });
  PRS.fill(0);
  return {
    role: input.role,
    sid: input.sid,
    ephemeralSecret: initialized.ephemeralSecret,
    share: initialized.share,
  };
}

export function finishPake(state: PakeState, peerShare: Uint8Array): SessionKeys {
  const ownAD = textEncoder.encode(state.role);
  const peerRole = state.role === 'sender' ? 'receiver' : 'sender';
  const peerAD = textEncoder.encode(peerRole);
  const isk = cpace.ristretto255.deriveIskInitiatorResponder({
    ephemeralSecret: state.ephemeralSecret,
    ownShare: state.share,
    peerShare,
    ownAD,
    peerAD,
    sid: state.sid,
    role: state.role === 'sender' ? 'initiator' : 'responder',
  });
  state.ephemeralSecret.fill(0);
  return {
    confirmationKey: deriveKey(isk, state.sid, 'skillspore/confirmation/v1'),
    receiptKey: deriveKey(isk, state.sid, 'skillspore/receipt/v1'),
  };
}

function deriveKey(isk: Uint8Array, sid: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', isk, sid, textEncoder.encode(info), 32));
}

export function createBindingMac(
  key: Uint8Array,
  binding: SessionBinding,
  role: 'sender' | 'receiver'
): string {
  return createHmac('sha256', key).update(canonicalJson({ binding, role })).digest('base64url');
}

export function verifyBindingMac(
  key: Uint8Array,
  binding: SessionBinding,
  role: 'sender' | 'receiver',
  received: string
): boolean {
  const expected = Buffer.from(createBindingMac(key, binding, role), 'base64url');
  const actual = Buffer.from(received, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createReceiptMac(
  key: Uint8Array,
  receipt: { packageHash: string; totalBytes: number; transferId: string }
): string {
  return createHmac('sha256', key).update(canonicalJson(receipt)).digest('base64url');
}

export function verifyReceiptMac(
  key: Uint8Array,
  receipt: { packageHash: string; totalBytes: number; transferId: string },
  received: string
): boolean {
  const expected = Buffer.from(createReceiptMac(key, receipt), 'base64url');
  const actual = Buffer.from(received, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

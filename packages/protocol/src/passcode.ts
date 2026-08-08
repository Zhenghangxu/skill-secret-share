import { randomInt } from 'node:crypto';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const NAMEPLATE_PATTERN = /^\d{4}$/;

export function generateSecretPhrase(wordCount = 3): string {
  if (!Number.isInteger(wordCount) || wordCount < 3) {
    throw new Error('Secret phrases must contain at least three words');
  }
  return Array.from({ length: wordCount }, () => wordlist[randomInt(wordlist.length)]!).join('-');
}

export function formatPasscode(nameplate: string, secret: string): string {
  if (!NAMEPLATE_PATTERN.test(nameplate)) throw new Error('Nameplate must contain four digits');
  const normalized = normalizeSecret(secret);
  return `${nameplate}-${normalized}`;
}

export function parsePasscode(passcode: string): { nameplate: string; secret: string } {
  const normalized = passcode.trim().toLowerCase();
  const separator = normalized.indexOf('-');
  if (separator < 0) throw new Error('Passcode must start with a four-digit nameplate');
  const nameplate = normalized.slice(0, separator);
  const secret = normalized.slice(separator + 1);
  if (!NAMEPLATE_PATTERN.test(nameplate))
    throw new Error('Passcode nameplate must contain four digits');
  return { nameplate, secret: normalizeSecret(secret) };
}

export function validateCustomSecret(secret: string): string {
  const normalized = normalizeSecret(secret);
  const words = normalized.split('-').filter(Boolean);
  if (words.length < 3 && normalized.length < 16) {
    throw new Error('Use at least three words or sixteen characters');
  }
  return normalized;
}

function normalizeSecret(secret: string): string {
  if (/[\u0000-\u001f\u007f]/.test(secret) || /\p{Cf}/u.test(secret)) {
    throw new Error('Passcode secret cannot contain control characters');
  }
  const normalized = secret
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) throw new Error('Passcode secret cannot be empty');
  return normalized;
}

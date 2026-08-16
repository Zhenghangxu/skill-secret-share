import { randomInt } from 'node:crypto';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export function generateSecretPhrase(wordCount = 4): string {
  if (!Number.isInteger(wordCount) || wordCount < 4) {
    throw new Error('Passcodes must contain at least four words');
  }
  return Array.from({ length: wordCount }, () => wordlist[randomInt(wordlist.length)]!).join('-');
}

export function normalizePasscode(passcode: string): string {
  return normalizeSecret(passcode);
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

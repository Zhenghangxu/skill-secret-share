import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const MINIMUM_CROC_VERSION = '10.7.0';

export interface CrocTransferOptions {
  relay?: string;
  executable?: string;
}

function executable(options: CrocTransferOptions): string {
  return options.executable ?? (process.env.SKILLSPORE_CROC_PATH?.trim() || 'croc');
}

function validateText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  if (/[\u0000-\u001f\u007f]/.test(normalized) || /\p{Cf}/u.test(normalized)) {
    throw new Error(`${label} cannot contain control characters`);
  }
  return normalized;
}

function validateLivePasscode(value: string): string {
  const normalized = validateText(value, 'Passcode');
  let storedTransferValue = normalized.startsWith('croc-store-v1.');
  if (!storedTransferValue) {
    try {
      const parsed = new URL(normalized);
      storedTransferValue = parsed.pathname.startsWith('/s/');
    } catch {
      // Live-transfer passcodes do not otherwise need to be URLs.
    }
  }
  if (storedTransferValue) {
    throw new Error('Passcode cannot be a croc stored-transfer token or URL');
  }
  return normalized;
}

function parseVersion(output: string): [number, number, number] | undefined {
  const match = output.match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

async function captureProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            `croc is required but was not found. Install croc ${MINIMUM_CROC_VERSION} or newer and ensure it is on PATH.`
          )
        );
      } else {
        reject(error);
      }
    });
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`croc ${args.join(' ')} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

export async function assertCrocAvailable(options: CrocTransferOptions = {}): Promise<void> {
  const output = await captureProcess(executable(options), ['--version']);
  const actual = parseVersion(output);
  const minimum = parseVersion(MINIMUM_CROC_VERSION)!;
  if (!actual)
    throw new Error(`Could not determine the installed croc version from: ${output.trim()}`);
  if (compareVersions(actual, minimum) < 0) {
    throw new Error(`croc ${MINIMUM_CROC_VERSION} or newer is required; found ${actual.join('.')}`);
  }
}

function globalArgs(options: CrocTransferOptions): string[] {
  if (!options.relay) return [];
  return ['--relay', validateText(options.relay, 'Relay address')];
}

async function runTransfer(input: {
  args: string[];
  code: string;
  options: CrocTransferOptions;
  quiet: boolean;
}): Promise<void> {
  const code = validateLivePasscode(input.code);
  const configDirectory = await mkdtemp(join(tmpdir(), 'skillspore-croc-config-'));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CROC_CONFIG_DIR: configDirectory,
      CROC_SECRET: code,
    };
    delete env.CROC_STORE_TOKEN;
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(executable(input.options), input.args, {
        env,
        stdio: input.quiet ? ['inherit', 'ignore', 'pipe'] : 'inherit',
      });
      let captured = '';
      if (input.quiet && child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          captured = (captured + chunk.toString()).slice(-16 * 1024);
        });
      }
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          reject(
            new Error(
              `croc is required but was not found. Install croc ${MINIMUM_CROC_VERSION} or newer and ensure it is on PATH.`
            )
          );
        } else {
          reject(error);
        }
      });
      child.once('close', (exitCode, signal) => {
        if (exitCode === 0) {
          resolvePromise();
          return;
        }
        const detail = captured.replaceAll(code, '[redacted]').trim();
        reject(
          new Error(
            `croc transfer failed (${signal ?? `exit ${exitCode}`})${detail ? `: ${detail}` : ''}`
          )
        );
      });
    });
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
}

export async function sendDirectoryWithCroc(
  directory: string,
  code: string,
  options: CrocTransferOptions = {}
): Promise<void> {
  await assertCrocAvailable(options);
  await runTransfer({
    args: [
      ...globalArgs(options),
      '--quiet',
      '--disable-clipboard',
      '--ignore-stdin',
      'send',
      resolve(directory),
    ],
    code,
    options,
    quiet: true,
  });
}

export async function receiveDirectoryWithCroc(
  outputDirectory: string,
  code: string,
  options: CrocTransferOptions = {}
): Promise<void> {
  await assertCrocAvailable(options);
  await runTransfer({
    args: [...globalArgs(options), '--out', resolve(outputDirectory)],
    code,
    options,
    quiet: false,
  });
}

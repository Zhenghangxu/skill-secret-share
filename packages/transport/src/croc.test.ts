import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCrocAvailable, receiveDirectoryWithCroc, sendDirectoryWithCroc } from './croc.js';

const temporaryDirectories: string[] = [];

async function fakeCroc(version = '10.7.0'): Promise<{
  executable: string;
  record: string;
  output: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'skillspore-croc-test-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, 'croc');
  const record = join(directory, 'record.json');
  const output = join(directory, 'output');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('croc version v${version}-test');
  process.exit(0);
}
fs.writeFileSync(process.env.FAKE_CROC_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  secret: process.env.CROC_SECRET,
  configDirectory: process.env.CROC_CONFIG_DIR,
  storedToken: process.env.CROC_STORE_TOKEN,
  configExists: fs.existsSync(process.env.CROC_CONFIG_DIR),
}));
if (process.env.FAKE_CROC_EXIT) {
  console.error('failed with ' + process.env.CROC_SECRET);
  process.exit(Number(process.env.FAKE_CROC_EXIT));
}
`
  );
  await chmod(executable, 0o700);
  return { executable, record, output };
}

afterEach(async () => {
  delete process.env.FAKE_CROC_RECORD;
  delete process.env.FAKE_CROC_EXIT;
  delete process.env.CROC_STORE_TOKEN;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('croc transport adapter', () => {
  it('passes the secret only through the child environment', async () => {
    const fake = await fakeCroc();
    process.env.FAKE_CROC_RECORD = fake.record;
    process.env.CROC_STORE_TOKEN = 'unrelated-stored-transfer';
    await sendDirectoryWithCroc(fake.output, 'four-word-secret-code', {
      executable: fake.executable,
      relay: 'relay.example.test:9009',
    });
    const record = JSON.parse(await readFile(fake.record, 'utf8')) as {
      args: string[];
      secret: string;
      configDirectory: string;
      storedToken?: string;
      configExists: boolean;
    };
    expect(record.args).toEqual([
      '--relay',
      'relay.example.test:9009',
      '--quiet',
      '--disable-clipboard',
      '--ignore-stdin',
      'send',
      fake.output,
    ]);
    expect(record.args).not.toContain(record.secret);
    expect(record.secret).toBe('four-word-secret-code');
    expect(record.storedToken).toBeUndefined();
    expect(record.configExists).toBe(true);
    await expect(stat(record.configDirectory)).rejects.toThrow();
  });

  it('receives into the requested directory without putting the code in argv', async () => {
    const fake = await fakeCroc();
    process.env.FAKE_CROC_RECORD = fake.record;
    await receiveDirectoryWithCroc(fake.output, 'receiver-secret-code', {
      executable: fake.executable,
    });
    const record = JSON.parse(await readFile(fake.record, 'utf8')) as {
      args: string[];
      secret: string;
    };
    expect(record.args).toEqual(['--out', fake.output]);
    expect(record.args).not.toContain(record.secret);
    expect(record.secret).toBe('receiver-secret-code');
  });

  it('rejects croc versions older than the supported security baseline', async () => {
    const fake = await fakeCroc('10.6.0');
    await expect(assertCrocAvailable({ executable: fake.executable })).rejects.toThrow(
      /10\.7\.0 or newer/
    );
  });

  it('redacts a passcode from captured sender errors', async () => {
    const fake = await fakeCroc();
    process.env.FAKE_CROC_RECORD = fake.record;
    process.env.FAKE_CROC_EXIT = '2';
    await expect(
      sendDirectoryWithCroc(fake.output, 'never-print-this-code', {
        executable: fake.executable,
      })
    ).rejects.toThrow(/failed with \[redacted\]/);
  });

  it.each([
    'croc-store-v1.example-token',
    'https://files.example.test/s/transfer-id#v1.decryption-key',
  ])('rejects stored-transfer passcodes before starting a live transfer', async (code) => {
    const fake = await fakeCroc();
    process.env.FAKE_CROC_RECORD = fake.record;
    await expect(
      receiveDirectoryWithCroc(fake.output, code, { executable: fake.executable })
    ).rejects.toThrow(/stored-transfer token or URL/);
    await expect(readFile(fake.record, 'utf8')).rejects.toThrow();
  });
});

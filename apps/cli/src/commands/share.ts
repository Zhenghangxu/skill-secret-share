import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  generateSecretPhrase,
  validateCustomSecret,
} from '../../../../packages/protocol/src/index.js';
import { prepareSkillSnapshot } from '../../../../packages/installer/src/index.js';
import { sendDirectoryWithCroc } from '../../../../packages/transport/src/index.js';
import { crocRelay, hasOption, positionalArgs } from '../options.js';
import { assertNotCancelled, printManifest, printSecretFindings } from '../ui.js';

async function promptCustomSecret(): Promise<string> {
  const first = assertNotCancelled(
    await p.password({ message: 'Custom passcode', mask: '*' }),
    'Sharing cancelled'
  );
  const second = assertNotCancelled(
    await p.password({ message: 'Repeat custom passcode', mask: '*' }),
    'Sharing cancelled'
  );
  if (first !== second) throw new Error('Custom passcodes do not match');
  return validateCustomSecret(first);
}

export async function runShare(args: string[]): Promise<void> {
  const [directory] = positionalArgs(args, ['--relay']);
  if (!directory) throw new Error('Usage: skillspore share <skill-directory>');
  p.intro(pc.bgGreen(pc.black(' SkillSpore share ')));
  const spinner = p.spinner();
  spinner.start('Validating and scanning skill');
  const prepared = await prepareSkillSnapshot(directory);
  try {
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

    const code = hasOption(args, '--custom-passcode')
      ? await promptCustomSecret()
      : generateSecretPhrase();
    p.note(`${pc.bold(code)}\n\nThe receiver should run: skillspore fetch`, 'One-time passcode');

    spinner.start('Waiting for one receiver and transferring skill');
    try {
      const relay = crocRelay(args);
      await sendDirectoryWithCroc(prepared.rootDir, code, relay ? { relay } : {});
    } catch (error) {
      spinner.stop('Transfer stopped');
      throw error;
    }
    spinner.stop('Transfer verified by receiver');
    p.outro(pc.green(`Transferred ${prepared.metadata.name} successfully.`));
  } finally {
    await prepared.cleanup();
  }
}

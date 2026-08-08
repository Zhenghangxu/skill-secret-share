import pc from 'picocolors';
import { initializeSkill } from '../../../../packages/installer/src/index.js';

export async function runInit(args: string[]): Promise<void> {
  const name = args.find((arg) => !arg.startsWith('-'));
  if (!name) throw new Error('Usage: skillspore init <name>');
  console.log(pc.green(`Created ${await initializeSkill(name)}`));
}

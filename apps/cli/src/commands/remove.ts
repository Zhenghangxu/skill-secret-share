import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  AGENTS,
  removeInstalledSkill,
  type AgentId,
  type InstallScope,
} from '../../../../packages/installer/src/index.js';
import { getOption, hasOption, positionalArgs } from '../options.js';
import { assertNotCancelled } from '../ui.js';

export async function runRemove(args: string[]): Promise<void> {
  const names = positionalArgs(args, ['--agent', '-a']);
  if (names.length === 0) throw new Error('Usage: skillspore remove <skill...>');
  const scope: InstallScope =
    hasOption(args, '--global') || hasOption(args, '-g') ? 'global' : 'project';
  const agentOption = getOption(args, '--agent') ?? getOption(args, '-a');
  const agents = agentOption ? (agentOption.split(',') as AgentId[]) : undefined;
  if (agents?.some((agent) => !(agent in AGENTS))) throw new Error('Unknown agent filter');
  const confirmed = assertNotCancelled(
    await p.confirm({
      message: `Remove ${names.join(', ')} from ${scope} scope?`,
      initialValue: false,
    }),
    'Removal cancelled'
  );
  if (!confirmed) throw new Error('Removal cancelled');
  const removed: string[] = [];
  for (const name of names) {
    removed.push(
      ...(await removeInstalledSkill({
        name,
        scope,
        ...(agents === undefined ? {} : { agents }),
      }))
    );
  }
  p.outro(
    removed.length > 0
      ? pc.green(`Removed ${removed.length} path(s).`)
      : pc.yellow('No matching skills found.')
  );
}

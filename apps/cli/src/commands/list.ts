import pc from 'picocolors';
import {
  AGENTS,
  listInstalledSkills,
  type AgentId,
  type InstallScope,
} from '../../../../packages/installer/src/index.js';
import { getOption, hasOption } from '../options.js';

export async function runList(args: string[]): Promise<void> {
  const scope: InstallScope =
    hasOption(args, '--global') || hasOption(args, '-g') ? 'global' : 'project';
  const agentOption = getOption(args, '--agent') ?? getOption(args, '-a');
  const agents = agentOption ? (agentOption.split(',') as AgentId[]) : undefined;
  if (agents?.some((agent) => !(agent in AGENTS))) throw new Error('Unknown agent filter');
  const skills = await listInstalledSkills({ scope, ...(agents === undefined ? {} : { agents }) });
  if (hasOption(args, '--json')) {
    console.log(JSON.stringify(skills, null, 2));
    return;
  }
  if (skills.length === 0) {
    console.log(pc.dim(`No ${scope} skills found.`));
    return;
  }
  for (const skill of skills) {
    console.log(
      `${pc.cyan(skill.name)}  ${pc.dim(skill.agents.map((agent) => AGENTS[agent].displayName).join(', '))}`
    );
    for (const path of skill.paths) console.log(`  ${pc.dim(path)}`);
  }
}

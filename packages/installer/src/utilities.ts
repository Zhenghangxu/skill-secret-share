import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENTS,
  getAgentSkillsDir,
  getCanonicalSkillsDir,
  type AgentId,
  type InstallScope,
} from './agents.js';

export interface InstalledSkill {
  name: string;
  scope: InstallScope;
  agents: AgentId[];
  paths: string[];
}

export function sanitizeSkillName(name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
  return name;
}

export async function listInstalledSkills(input: {
  scope: InstallScope;
  agents?: AgentId[];
  cwd?: string;
}): Promise<InstalledSkill[]> {
  const cwd = input.cwd ?? process.cwd();
  const agents = input.agents ?? (Object.keys(AGENTS) as AgentId[]);
  const skills = new Map<string, InstalledSkill>();
  for (const agent of agents) {
    const root = getAgentSkillsDir(agent, input.scope, cwd);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const existing = skills.get(entry.name) ?? {
        name: entry.name,
        scope: input.scope,
        agents: [],
        paths: [],
      };
      if (!existing.agents.includes(agent)) existing.agents.push(agent);
      existing.paths.push(join(root, entry.name));
      skills.set(entry.name, existing);
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeInstalledSkill(input: {
  name: string;
  scope: InstallScope;
  agents?: AgentId[];
  cwd?: string;
}): Promise<string[]> {
  const name = sanitizeSkillName(input.name);
  const cwd = input.cwd ?? process.cwd();
  const agents = input.agents ?? (Object.keys(AGENTS) as AgentId[]);
  const paths = new Set(
    agents.map((agent) => join(getAgentSkillsDir(agent, input.scope, cwd), name))
  );
  if (input.agents === undefined) paths.add(join(getCanonicalSkillsDir(input.scope, cwd), name));
  const removed: string[] = [];
  for (const path of paths) {
    if (
      await lstat(path).then(
        () => true,
        () => false
      )
    ) {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return removed;
}

export async function initializeSkill(name: string, cwd = process.cwd()): Promise<string> {
  const skillName = sanitizeSkillName(name);
  const directory = join(cwd, skillName);
  const skillFile = join(directory, 'SKILL.md');
  await mkdir(directory, { recursive: true });
  if (
    await lstat(skillFile).then(
      () => true,
      () => false
    )
  )
    throw new Error(`${skillFile} already exists`);
  await writeFile(
    skillFile,
    `---\nname: ${skillName}\ndescription: Describe what this skill does and when to use it.\n---\n\n# ${skillName}\n\nAdd skill instructions here.\n`
  );
  return skillFile;
}

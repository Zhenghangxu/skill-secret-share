import { homedir } from 'node:os';
import { join } from 'node:path';
import { agents as upstreamAgents } from './upstream/agents.js';

export type AgentId = 'codex' | 'claude-code' | 'cursor';
export type InstallScope = 'project' | 'global';
export type InstallMode = 'copy' | 'symlink';

export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  projectSkillsDir: string;
  globalSkillsDir: () => string;
  detectInstalled: () => Promise<boolean>;
}

function adaptAgent(id: AgentId): AgentDefinition {
  const upstream = upstreamAgents[id];
  if (!upstream.globalSkillsDir) throw new Error(`Upstream agent ${id} has no global skills path`);
  return {
    id,
    displayName: upstream.displayName ?? upstream.name,
    projectSkillsDir: upstream.skillsDir,
    globalSkillsDir: () => upstream.globalSkillsDir!,
    detectInstalled: upstream.detectInstalled,
  };
}

export const AGENTS: Record<AgentId, AgentDefinition> = {
  codex: adaptAgent('codex'),
  'claude-code': adaptAgent('claude-code'),
  cursor: adaptAgent('cursor'),
};

export async function detectInstalledAgents(): Promise<AgentId[]> {
  const results = await Promise.all(
    (Object.values(AGENTS) as AgentDefinition[]).map(async (agent) => ({
      id: agent.id,
      installed: await agent.detectInstalled(),
    }))
  );
  return results.filter((result) => result.installed).map((result) => result.id);
}

export function getCanonicalSkillsDir(scope: InstallScope, cwd = process.cwd()): string {
  return scope === 'global'
    ? join(homedir(), '.agents', 'skills')
    : join(cwd, upstreamAgents.codex.skillsDir);
}

export function getAgentSkillsDir(
  agent: AgentId,
  scope: InstallScope,
  cwd = process.cwd()
): string {
  const definition = AGENTS[agent];
  return scope === 'global' ? definition.globalSkillsDir() : join(cwd, definition.projectSkillsDir);
}

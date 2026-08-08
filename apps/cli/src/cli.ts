#!/usr/bin/env node
import pc from 'picocolors';
import { runFetch } from './commands/fetch.js';
import { runInit } from './commands/init.js';
import { runList } from './commands/list.js';
import { runRemove } from './commands/remove.js';
import { runShare } from './commands/share.js';
import { sanitizeTerminal } from './ui.js';

const HELP = `
${pc.bold('SkillSpore')} — secure peer-to-peer Agent Skill sharing

Usage:
  skillspore share <skill-directory> [--custom-passcode] [--server <wss-url>]
  skillspore fetch [--download-only] [--output <directory>] [--server <wss-url>]
  skillspore list [--global] [--agent <agent>] [--json]
  skillspore remove <skills...> [--global] [--agent <agent>]
  skillspore init <name>

Supported agents: codex, claude-code, cursor
Passcodes are always entered through hidden interactive prompts.
`;

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log('0.1.0-beta.1');
    return;
  }
  switch (command) {
    case 'share':
      await runShare(args);
      break;
    case 'fetch':
      await runFetch(args);
      break;
    case 'list':
    case 'ls':
      await runList(args);
      break;
    case 'remove':
    case 'rm':
      await runRemove(args);
      break;
    case 'init':
      await runInit(args);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!/cancelled/i.test(message)) console.error(pc.red(`Error: ${sanitizeTerminal(message)}`));
  process.exitCode = 1;
});

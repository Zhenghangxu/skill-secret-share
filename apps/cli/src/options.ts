export const DEFAULT_SERVER_URL = 'ws://127.0.0.1:8787/v1/rendezvous';

export function getOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function hasOption(args: string[], name: string): boolean {
  return args.includes(name);
}

export function serverUrl(args: string[]): string {
  return getOption(args, '--server') ?? process.env.SKILLSPORE_SERVER_URL ?? DEFAULT_SERVER_URL;
}

export function iceTransportPolicy(args: string[]): 'all' | 'relay' {
  return hasOption(args, '--force-relay') ? 'relay' : 'all';
}

export function positionalArgs(args: string[], optionsWithValues: string[] = []): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith('-')) {
      if (optionsWithValues.includes(arg)) index++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

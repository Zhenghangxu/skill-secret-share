export function getOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function hasOption(args: string[], name: string): boolean {
  return args.includes(name);
}

export function crocRelay(args: string[]): string | undefined {
  return getOption(args, '--relay') ?? process.env.SKILLSPORE_CROC_RELAY;
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

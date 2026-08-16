# SkillSpore

SkillSpore securely transfers one [Agent Skill](https://agentskills.io/specification) from one
computer to another and installs it for Codex, Claude Code, or Cursor.

File transfer is delegated to [croc](https://github.com/schollz/croc). SkillSpore keeps the
skill-specific safety layer: validation, secret scanning, private temporary storage, review,
diffing, and transactional installation.

> [!WARNING]
> SkillSpore is experimental beta software. It relies on croc's security and public relay by
> default. Do not use it for highly sensitive material without reviewing both projects and choosing
> a relay appropriate for your threat model.

## Requirements

- Node.js 22.20 or newer
- pnpm 10.17.1 for development
- croc 10.7.0 or newer on both computers

Install croc using the instructions in the [croc README](https://github.com/schollz/croc#install).
For example, on macOS:

```shell
brew install croc
```

## How it works

The sender validates the skill, scans it for likely secrets, and starts croc with a one-time
four-word passcode:

```shell
skillspore share ~/skills/example-skill
```

The receiver enters that passcode through a hidden prompt:

```shell
skillspore fetch
```

croc performs password-authenticated key agreement, end-to-end encryption, local-network and relay
connection selection, and transfer integrity checks. The passcode is supplied to croc through its
recommended `CROC_SECRET` environment variable and never appears in process arguments.

The receiver first sees croc's file-count and byte-size prompt. Accepted files land in a private
temporary directory. SkillSpore then requires exactly one skill directory, independently reapplies
its package limits and path checks, scans the received files, shows the metadata and file list, and
installs only after confirmation. Multi-agent installation is staged and rolled back if any target
fails.

## Commands

```text
skillspore share <skill-directory> [--custom-passcode] [--relay <host:port>]
skillspore fetch [--download-only] [--output <directory>] [--relay <host:port>]
skillspore list [--global] [--agent <agent>] [--json]
skillspore remove <skills...> [--global] [--agent <agent>]
skillspore init <name>
```

Set `SKILLSPORE_CROC_RELAY` instead of repeating `--relay`. Set `SKILLSPORE_CROC_PATH` if the croc
binary is not on `PATH`.

## Development

```shell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Run the CLI from the workspace:

```shell
pnpm dev:cli share /path/to/example-skill
pnpm dev:cli fetch
```

For two-computer testing or a private relay, see the [end-to-end testing guide](docs/lan-e2e-testing.md)
and [deployment guide](docs/deployment.md).

## Skill limits and safeguards

- One skill directory per transfer.
- 25 MiB total, 10 MiB per file, and 1,000 files.
- Symlinks, special files, unsafe paths, and traversal are rejected during SkillSpore validation.
- Received content remains under a private temporary directory until review and installation
  (mode `0700` where POSIX permissions apply).
- Bundled scripts are never executed automatically.

See the [threat model](THREAT_MODEL.md) and [transport boundary](docs/protocol.md) for details.

## License

SkillSpore is MIT licensed. croc is a separate MIT-licensed project and is not bundled with this
repository.

# SkillSpore

SkillSpore securely transfers one [Agent Skill](https://agentskills.io/specification) directly from
one computer to another and installs it for Codex, Claude Code, or Cursor.

> [!WARNING]
> SkillSpore is an experimental public beta. Its PAKE-based session design has automated test-vector
> coverage but has not received an independent security audit. Do not use it for highly sensitive
> material yet.

## How it works

The sender validates and scans a skill, then receives a one-time passcode:

```shell
skillspore share ~/skills/example-skill
```

The receiver enters that passcode through a hidden prompt:

```shell
skillspore fetch
```

The peers authenticate the passcode with CPace, bind it to their WebRTC DTLS certificate
fingerprints, and transfer the skill over a reliable DataChannel. WebRTC connects directly when
possible and uses a managed TURN relay when necessary. The rendezvous service never receives the
secret phrase, skill contents, or decryption key.

Before installation, the receiver sees the metadata, file list, executable files, requested tools,
and any changes to an existing installation. Multi-agent installation is staged and rolled back if
any target fails.

## Commands

```text
skillspore share <skill-directory> [--custom-passcode] [--server <wss-url>] [--force-relay]
skillspore fetch [--download-only] [--output <directory>] [--server <wss-url>] [--force-relay]
skillspore list [--global] [--agent <agent>] [--json]
skillspore remove <skills...> [--global] [--agent <agent>]
skillspore init <name>
```

Passcodes are never accepted through command arguments or environment variables.
`--force-relay` is reserved for TURN deployment testing; normal transfers prefer direct WebRTC.

## Development

Requirements: Node 22.20 or newer and pnpm 10.17.1.

```shell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Start the local rendezvous service:

```shell
pnpm dev:server
```

In two other terminals:

```shell
pnpm dev:cli share /path/to/example-skill
pnpm dev:cli fetch
```

For a fully local test between two computers, follow the
[LAN end-to-end testing guide](docs/lan-e2e-testing.md).

The local Node reference service uses Cloudflare STUN only by default. Configure Twilio credentials
only when testing the rollback credential provider:

```shell
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
```

The production target is the Cloudflare Worker and per-session Durable Object described in the
[deployment guide](docs/deployment.md). Production rollout remains gated by the accepted
[Cloudflare architecture decision](docs/cloudflare-production-decision.md).

## Package and infrastructure limits

- One sender and one receiver per session.
- 10-minute waiting TTL and 15-minute connected TTL.
- 25 MiB total, 10 MiB per file, and 1,000 files.
- Symlinks, special files, unsafe paths, and traversal are rejected.
- Received files are quarantined and hash-verified before installation.
- Bundled scripts are never executed automatically.

See [the threat model](THREAT_MODEL.md), [protocol description](docs/protocol.md), and
[deployment guide](docs/deployment.md) for details.

## Upstream agent configuration

Agent paths are imported unchanged from a pinned commit of
[`vercel-labs/skills`](https://github.com/vercel-labs/skills). Run:

```shell
pnpm upstream:check
pnpm upstream:sync -- --ref <commit-or-tag>
```

The weekly workflow reports upstream drift. Updates remain pinned until their diffs and regression
tests are reviewed.

## License

SkillSpore is MIT licensed. Upstream notices are retained under `third_party/`.

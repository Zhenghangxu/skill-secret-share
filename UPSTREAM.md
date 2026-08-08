# Upstream provenance

SkillSpore's agent directory conventions and installation behavior were derived from
[`vercel-labs/skills`](https://github.com/vercel-labs/skills), pinned during the initial import at:

```text
941a7bcfeca4bf07913b9fb6f8ed81f20ff5297c
```

The upstream project is MIT licensed. SkillSpore intentionally does not include its marketplace,
remote-source, update, synchronization, lock-file, audit-service, or telemetry behavior.

## What is vendored

Only the upstream agent registry sources needed to resolve agent-specific skill directories are
vendored in `packages/installer/src/upstream/`. SkillSpore does not import runtime modules from the
`skills` npm package. The exact upstream commit and SHA-256 digest of every imported file are stored
in `upstream-agents.json`.

Vendoring this small compatibility boundary makes installs reproducible and lets SkillSpore review
upstream directory or behavior changes before they affect a user's filesystem.

## Update procedure

The `Check upstream agent registry` GitHub Actions workflow runs every Monday and executes
`pnpm upstream:check` against upstream `main`. A changed digest fails the workflow and identifies
the affected files.

To adopt an upstream change:

1. Review the upstream diff, especially directory resolution, supported agent identifiers, and
   global-versus-project install behavior.
2. Run `pnpm upstream:sync -- --ref <reviewed-commit>` to copy the reviewed sources and update the
   pinned commit and hashes.
3. Update SkillSpore's adapter if the upstream contract changed.
4. Run type checks, tests, the packaged CLI smoke test, and installation-path tests before merging.

Updates are deliberately not applied automatically. Agent configuration controls filesystem write
locations, so an upstream change must pass local compatibility and security review before release.

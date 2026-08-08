# SkillSpore

## Summary

SkillSpore is a CLI for securely sharing and installing an Agent Skill directly between two computers.

It combines PairDrop's live peer-to-peer transfer model with the guided installation experience of Vercel's `skills` CLI. Instead of archiving, uploading, downloading, extracting, and manually installing a skill, two users complete the process with a share command, a one-time passcode, and an interactive install flow.

The sender and receiver must be online at the same time. SkillSpore never permanently hosts the skill, and the session closes after one successful transfer.

> SkillSpore is PairDrop for Agent Skills: send a skill directly to another developer and install it in one guided CLI flow.

## User experience

### 1. Sender shares a skill

```shell
skillspore share ~/skills/example-skill
```

SkillSpore validates the directory, warns about likely secrets, creates a temporary encrypted package, and generates a one-time passcode.

```text
Skill: example-skill
Files: 8
Passcode: 7-harbor-lantern

Waiting for receiver...
Do not close this terminal.
```

The sender can alternatively enter a custom passcode through a secure interactive prompt.

### 2. Receiver fetches the skill

At the same time, the receiver runs:

```shell
skillspore fetch
```

SkillSpore securely prompts for the passcode instead of placing it in shell history or the process list:

```text
Passcode: [hidden input]
```

After connecting securely to the sender, SkillSpore presents a Vercel-style installation flow:

```text
Connected to sender.

Skill: example-skill
Description: Example skill description
Files: 8

? Install for which agents?
  Codex
  Claude Code
  Cursor

? Installation scope?
  Project
  Global

? Install example-skill? Yes
```

SkillSpore transfers the package, verifies it, and installs the skill into the correct agent directories.

### 3. Session completes

```text
Transferred and installed example-skill successfully.
```

The sender is notified, the one-time session closes, temporary package data is deleted, and both commands exit.

## Core behavior

- Share one skill with one receiver per session.
- Require both users to remain online during transfer.
- Work across a LAN or the Internet.
- Connect peers directly when possible, with an encrypted relay fallback when NATs or firewalls prevent it.
- Never persist skill files on SkillSpore infrastructure.
- Display whether the transfer is direct or relayed.
- Close the session after success, cancellation, failure, or timeout.
- Apply strict session, package-size, and relay-bandwidth limits.

## Security and installation safety

- Use a short-lived, single-use passcode with a password-authenticated key exchange (PAKE) to establish the end-to-end encrypted session.
- Treat the passcode as a secret, not merely a public room name.
- Never include passcodes in process arguments, logs, analytics, crash reports, or relay-visible data.
- Bind the authenticated session to both peers, the transport fingerprints, and the transferred package hash so a signaling service cannot substitute a peer or package.
- Rate-limit passcode attempts and invalidate the session after success, timeout, or repeated failures.
- Validate `SKILL.md` against the Agent Skills standard before sharing.
- Perform best-effort secret scanning and warn about `.env` files, credentials, private keys, tokens, and other likely secrets without claiming that every secret can be detected.
- Reject unsafe paths, symlinks, special files, and excessive package sizes.
- Receive into a quarantined temporary directory and verify integrity before installation.
- Show the skill metadata, files, executable files, and requested tools to the receiver.
- Require confirmation before installation and never execute bundled scripts automatically.
- If the skill already exists, show a diff and require explicit overwrite confirmation.
- Stage multi-agent installations before committing them, and roll back partial changes when an installation fails.
- Remove temporary decrypted files after success or cancellation and clean up abandoned session directories on the next startup.

## Installation integration

SkillSpore should detect supported agents and let the receiver select project or global scope. Where practical, it should pass the verified local directory to:

```shell
skills add <local-path>
```

This reuses existing agent detection and installation conventions instead of rebuilding every agent-specific installer.

## Implementation starting point

Start by cloning the Vercel [`skills`](https://github.com/vercel-labs/skills) repository and modifying it to support the SkillSpore workflow.

Reuse its existing skill validation, agent detection, interactive prompts, installation scopes, and agent-specific installation logic. A received and verified skill directory should enter that existing flow as a local installation source.

The intended implementation direction is:

```shell
git clone https://github.com/vercel-labs/skills.git
```

Keep the P2P transport as a separate module with a narrow output—a verified quarantined directory—rather than weaving networking throughout the installer. This preserves a clean security boundary and makes future upstream changes easier to adopt.

The fork should remove or disable marketplace search, update/version tracking, telemetry, and unrelated remote-source behavior that conflicts with SkillSpore's private one-time-transfer scope.

PairDrop should be treated as the UX and connectivity reference, not as a reusable CLI transport: the cross-platform Node transport is new work. The first technical spike should compare a maintained WebRTC implementation with a Magic Wormhole-style PAKE, rendezvous, direct-transfer, and relay protocol before locking in the networking library.

## Technical shape

```text
Sender CLI
    |
    | short-lived rendezvous/signaling
    v
Direct end-to-end encrypted connection
    |
    | encrypted relay fallback
    v
Receiver CLI -> quarantine -> verify -> review -> install
```

The supporting service may provide rendezvous, signaling, STUN, TURN, or relay functionality, but it must not store the skill or possess the encryption key. LAN discovery can reduce reliance on the public service when both users are on the same network.

The public service is still real infrastructure. It needs short session TTLs, attempt and bandwidth rate limits, abuse controls, and minimal metadata retention. Relayed transfers may create meaningful bandwidth cost even though no file is persistently hosted.

## Initial commands

The following command names, options, arguments, and output are suggestions for a prototype only. They should be refined during implementation and user testing; they are not a finalized public CLI contract.

```shell
# Generate a passcode and wait for one receiver
skillspore share <skill-directory>

# Securely prompt for a custom passcode
skillspore share <skill-directory> --custom-passcode

# Fetch, inspect, and install
skillspore fetch

# Fetch without installing
skillspore fetch --download-only
```

Both fetch commands prompt securely for the one-time passcode. A positional passcode or raw `--password VALUE` option should not be supported because shell history and process listings may expose it.

## Non-goals

The first version will not include:

- offline or asynchronous sharing;
- permanent hosting, torrenting, IPFS, or blockchain storage;
- a public marketplace, search directory, or publishing service;
- version history, subscriptions, synchronization, or automatic updates;
- anonymous networking;
- silent installation without receiver review;
- guaranteed deletion after the receiver has installed or copied the skill.

## MVP success criteria

The MVP is complete when:

1. A sender can share one valid skill directory with one receiver.
2. The peers can connect over LAN and Internet, using a relay when necessary.
3. A PAKE-authenticated session prevents the signaling service, an unauthorized participant, or a relay from reading or replacing the transferred skill.
4. The receiver can inspect, compare, and install the skill for Codex, Claude Code, and Cursor.
5. Existing installations are not overwritten silently, and partial multi-agent installations are rolled back.
6. Both commands terminate cleanly, and abandoned temporary session data is cleaned up safely.

SkillSpore's value is convenience and safety, not decentralized storage: it removes the file-sharing and manual-installation steps while keeping every transfer temporary and peer-to-peer.

# SkillSpore threat model

## Status

This document describes the `0.1.0-beta.1` design. The implementation and its CPace dependency have
not received an independent audit. The beta must not claim audited or production-grade security.

## Protected assets

- The one-time secret phrase.
- Skill file contents and metadata beyond what the receiver reviews.
- Integrity of the selected sender, receiver, WebRTC connection, and installed package.
- Existing agent skill installations during overwrite and rollback.

## Trusted components

- The sender and receiver operating systems and Node.js runtimes.
- The local SkillSpore CLI installation and npm dependency supply chain.
- The receiver's confirmation decisions.

The rendezvous service, signaling path, TURN relay, and network are not trusted with skill contents
or the secret phrase.

## Security properties

- The rendezvous service receives only a four-digit nameplate, CPace public shares, SDP, ICE
  candidates, and short-lived TURN credentials. It never receives the secret words.
- CPace converts the low-entropy phrase into a shared session key without enabling passive offline
  password guessing. Each active attempt provides at most one online guess and is rate-limited.
- The CPace-derived confirmation key authenticates the protocol version, roles, session identifier,
  nameplate, and both DTLS certificate fingerprints. A signaling intermediary cannot silently
  substitute a different WebRTC connection.
- WebRTC DTLS encrypts the DataChannel end to end, including when TURN forwards packets.
- Every file has an authenticated manifest size and SHA-256 digest. The receiver verifies the
  complete manifest, file contents, and `SKILL.md` metadata before installation.
- The receiver returns an HMAC-authenticated receipt covering the package hash, byte count, and
  transfer ID. The sender acknowledges that receipt before the session is closed.
- Installation stages all targets and restores backups if any commit fails.

## Known limitations

- A malicious rendezvous service can deny service, delay messages, expose peer IP addresses through
  signaling, or consume TURN quota. It should not be able to read or replace an authenticated skill.
- The four-digit nameplate is public and intentionally provides no secrecy.
- Secret scanning is best-effort and cannot prove that a skill is free of credentials.
- Skill instructions may still be malicious. SkillSpore shows requested tools and executable files
  but cannot determine the semantic intent of instructions.
- Installed skills run with the permissions granted by their agent. SkillSpore never executes them
  during transfer or installation.
- JavaScript strings cannot be reliably wiped from memory; the CLI avoids logging or persisting the
  passcode but cannot guarantee immediate memory erasure.
- Crash recovery journals protect agent installation paths, but concurrent SkillSpore installation
  processes are not supported in the beta.

## Release requirements

Before a stable `1.0` release:

1. Independently review the CPace integration, transcript binding, and receipt construction.
2. Fuzz signaling, control messages, manifests, and binary file frames.
3. Perform dependency and npm provenance review.
4. Run direct and TURN-relayed interoperability tests across supported operating systems.
5. Publish the review findings and resolve all high-severity issues.

# Threat model

This document describes the croc-backed SkillSpore design.

## Assets

- Confidentiality and integrity of transferred skill contents.
- The receiver's existing files and agent configuration.
- Passcode secrecy until the intended receiver connects.
- Availability of the sender, receiver, and any relay.

## Trust boundaries

SkillSpore trusts the local Node.js runtime, the installed croc binary, croc's cryptographic and
transfer implementation, and the chosen agent installers. The sender and receiver machines must not
already be compromised.

The network and croc relay are untrusted with plaintext. croc uses password-authenticated key
agreement and end-to-end encryption, including when traffic passes through a relay. A relay can
observe connection metadata and ciphertext sizes, deny service, delay traffic, or consume resources.

## Controls

- SkillSpore requires croc 10.7.0 or newer and invokes it without a shell.
- Four-word passcodes are generated with cryptographic randomness. Custom passcodes require at least
  three words or sixteen characters.
- Passcodes are entered through masked prompts and passed to croc in `CROC_SECRET`, never argv.
- A fresh `CROC_CONFIG_DIR` prevents remembered or classic-mode croc settings from changing a run.
- The receiver sees croc's file-count and byte-size prompt before accepting network data.
- Received files are confined to a random mode-`0700` directory and never executed.
- After transfer, SkillSpore independently rejects extra top-level entries, symlinks, special files,
  unsafe paths, excessive depth, excessive file count, files over 10 MiB, and packages over 25 MiB.
- The receiver sees validated metadata, files, executable markers, secret-scan findings, and diffs
  before installation.
- Installation is staged and rolled back if a multi-agent commit fails.

## Residual risks

- Security inherits bugs or compromises in croc, its release distribution, and the selected relay.
- Anyone who learns the passcode before the intended receiver can race to receive or disrupt the
  transfer. Confirm passcodes over an authenticated private channel.
- Environment variables are safer than argv but remain visible to the same user, administrators, and
  sufficiently privileged local software while croc is running.
- croc's acceptance prompt shows a summary, not SkillSpore's full manifest. Package limits and path
  rules are enforced after receipt, so a peer with the passcode can waste temporary disk space or
  bandwidth before SkillSpore rejects the payload.
- Secret scanning is best-effort and can miss credentials or produce false positives.
- A malicious but authenticated sender can provide a valid, dangerous skill. Human review remains
  required; SkillSpore does not sandbox a skill when an agent later uses it.
- Symlink installation mode intentionally creates links in agent directories. It does not permit
  symlinks inside transferred skills.

## Maintenance

Track croc security releases, test the minimum supported version on macOS, Linux, and Windows, and
raise the version floor when upstream path-safety or cryptographic fixes require it. Revisit the
subprocess contract before forwarding additional croc flags or adopting stored transfers.

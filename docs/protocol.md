# SkillSpore protocol v1

## Rendezvous

The sender opens `wss://<service>/v1/rendezvous` and sends `create`. The service allocates a random
four-digit nameplate and 32-byte session identifier. The receiver submits only that nameplate; the
remaining passcode words never leave the peers except as inputs to CPace.

The service forwards JSON signaling messages but does not persist them. Sessions accept one sender
and one receiver and expire after ten minutes while waiting or fifteen minutes after pairing.

## Peer authentication

Both peers derive a password-related string with scrypt and run CPace Ristretto255/SHA-512 using the
server-provided session identifier. The sender uses the CPace initiator role and the receiver uses
the responder role.

The resulting intermediate key is expanded with HKDF-SHA-256 into separate confirmation and receipt
keys. After WebRTC connects, both peers exchange role-specific HMACs over:

- protocol version;
- session identifier and nameplate;
- sender and receiver roles;
- initiator DTLS certificate fingerprint;
- responder DTLS certificate fingerprint.

Failure aborts the session before skill metadata or file data is sent.

## Transfer

Two ordered, reliable WebRTC DataChannels are used:

- `skillspore/control/v1` carries JSON control messages;
- `skillspore/files/v1` carries binary file frames.

The sender first sends a canonical manifest containing the skill metadata, paths, sizes, SHA-256
digests, executable flags, and total byte count. The receiver reviews it and explicitly accepts or
rejects the transfer.

Each binary frame contains a 16-byte header:

```text
uint32 file index
uint64 byte offset
uint32 payload length
payload bytes
```

Payloads are limited to 64 KiB and must arrive at the exact expected offset. Files are written only
inside a newly created permission-restricted quarantine directory.

After verification, the receiver sends an HMAC-authenticated receipt over the package hash, total
bytes, and transfer ID. The sender verifies it and returns `receipt-ack` before closing the session.

## Installation

The receiver revalidates `SKILL.md`, compares its parsed metadata to the authenticated manifest,
shows diffs for existing targets, and stages all selected installation paths beside their final
locations. Existing targets are renamed to backups before staged targets are committed. Any failure
removes new targets and restores all backups in reverse order.

# Transport boundary

SkillSpore does not implement a network protocol. It invokes croc 10.7.0 or newer as a subprocess
and treats a successful croc exit as completion of the encrypted file transfer.

## Sender

1. SkillSpore validates the directory, applies package limits, hashes its files, and runs secretlint.
2. It generates a four-word passcode, unless the user enters a stronger custom passcode.
3. It starts `croc --quiet --disable-clipboard send <absolute-directory>`.
4. The passcode is passed only in `CROC_SECRET`; it is never placed in argv.
5. SkillSpore reports success only after croc exits successfully.

## Receiver

1. SkillSpore reads the passcode with a masked prompt.
2. It creates a mode-`0700` temporary directory.
3. It starts `croc --out <temporary-directory>` with the passcode in `CROC_SECRET`.
4. croc shows the incoming file count and byte size and asks the user to accept.
5. After croc succeeds, SkillSpore requires exactly one directory, rejects unsafe content, reapplies
   its package limits, hashes every regular file, and runs secretlint.
6. Only reviewed content is copied or symlinked into an agent's skills directory, using the existing
   transactional installer.

Each invocation gets an isolated temporary `CROC_CONFIG_DIR`. This prevents remembered croc flags or
classic-mode settings from silently changing SkillSpore's behavior. `CROC_STORE_TOKEN` is removed
from the child environment so an unrelated stored transfer cannot replace the requested live
transfer.

An optional `--relay <host:port>` is forwarded as croc's global `--relay` option. Otherwise croc's
normal local/direct discovery and public relay defaults apply.

The adapter deliberately does not parse or reimplement croc's wire format. Cryptographic choices,
relay negotiation, reconnects, framing, transfer hashes, and compatibility belong to croc upstream.

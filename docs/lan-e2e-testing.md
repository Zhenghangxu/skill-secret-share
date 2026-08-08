# LAN end-to-end testing

This procedure tests SkillSpore between two computers on the same LAN using the normal protocol.
PC A runs the rendezvous service and sends the skill. PC B receives it. The rendezvous service only
handles pairing and WebRTC signaling; the skill travels directly between the peers.

The test disables STUN and TURN so a successful transfer proves that the peers connected using
local network candidates only.

## Prerequisites

- PC A and PC B are connected to the same LAN.
- Both computers have cloned this repository.
- Node.js 22.20.0 or newer is installed.
- VPNs are disabled temporarily if they interfere with local routing.
- Node.js is allowed through the private-network firewall on both computers.

## 1. Prepare both computers

Run these commands on PC A and PC B:

```shell
git switch main
git pull --ff-only origin main
git rev-parse --short HEAD
node --version
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Confirm that both computers report the same Git commit and that Node.js is version 22.20.0 or
newer.

## 2. Find PC A's LAN address

On macOS:

```shell
ipconfig getifaddr en0
```

On Linux:

```shell
hostname -I
```

On Windows PowerShell:

```powershell
ipconfig
```

The examples below assume that PC A's LAN address is `192.168.1.50`. Replace it with the actual
address.

## 3. Start rendezvous on PC A

Open the first terminal on PC A.

On macOS or Linux:

```shell
SKILLSPORE_ICE_SERVERS_JSON='[]' pnpm dev:server
```

On Windows PowerShell:

```powershell
$env:SKILLSPORE_ICE_SERVERS_JSON='[]'
pnpm dev:server
```

The empty ICE server array disables STUN and TURN. Expected output:

```text
SkillSpore rendezvous listening on port 8787
```

Verify the service locally on PC A:

```shell
curl http://127.0.0.1:8787/healthz
```

Expected response:

```json
{ "ok": true }
```

## 4. Verify connectivity from PC B

On macOS or Linux:

```shell
curl http://192.168.1.50:8787/healthz
```

On Windows PowerShell:

```powershell
curl.exe http://192.168.1.50:8787/healthz
```

Do not continue until the response is:

```json
{ "ok": true }
```

If the request fails, check the following:

- PC A's firewall allows inbound connections for Node.js.
- Both computers are connected to the same subnet.
- The router does not have wireless client or AP isolation enabled.
- `192.168.1.50` was replaced with PC A's active LAN address.
- TCP port 8787 is not blocked or already occupied.

## 5. Create a test skill on PC A

Open a second terminal on PC A and run:

```shell
pnpm dev:cli init lan-e2e-skill
```

Optionally add a file on macOS or Linux:

```shell
echo "Transferred over the LAN" > lan-e2e-skill/hello.txt
```

Or on Windows PowerShell:

```powershell
Set-Content lan-e2e-skill/hello.txt "Transferred over the LAN"
```

## 6. Share from PC A

In PC A's second terminal, run:

```shell
pnpm dev:cli share ./lan-e2e-skill \
  --server ws://127.0.0.1:8787/v1/rendezvous
```

The sender displays a one-time passcode and waits for one receiver. Keep this terminal open.

## 7. Fetch from PC B

On macOS or Linux:

```shell
pnpm dev:cli fetch \
  --download-only \
  --output ./received-lan-e2e \
  --server ws://192.168.1.50:8787/v1/rendezvous
```

On Windows PowerShell:

```powershell
pnpm dev:cli fetch --download-only --output ./received-lan-e2e `
  --server ws://192.168.1.50:8787/v1/rendezvous
```

Then:

1. Enter the passcode displayed on PC A.
2. Review the received manifest.
3. Confirm the transfer.

## 8. Confirm the direct transfer

PC A should report output similar to:

```text
Receiver authenticated (direct)
Transferred lan-e2e-skill successfully.
```

PC B should report output similar to:

```text
Sender authenticated (direct)
Skill transfer verified
Downloaded lan-e2e-skill to ...
```

The important result is `(direct)` on both computers. Because the rendezvous service supplied no
STUN or TURN servers, this confirms a direct LAN-only WebRTC connection.

Inspect the received files on macOS or Linux:

```shell
find received-lan-e2e -type f -print
cat received-lan-e2e/hello.txt
```

On Windows PowerShell:

```powershell
Get-ChildItem received-lan-e2e -Recurse
Get-Content received-lan-e2e/hello.txt
```

The expected file content is:

```text
Transferred over the LAN
```

## 9. Shut down the test

Press `Ctrl+C` in PC A's rendezvous terminal. The downloaded skill on PC B can then be inspected or
removed.

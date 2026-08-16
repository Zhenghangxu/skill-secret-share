# Cloudflare integration guide

This guide walks through deploying SkillSpore's rendezvous Worker, Durable Object, and Cloudflare
Realtime TURN integration. Start with staging, ideally in a separate Cloudflare account so its free
quotas and rate-limit counters cannot affect production.

## 1. Prepare your machine

From the repository root:

```shell
cd /Users/jasonxu/Documents/personal/skill-secret-share

nvm install 22.20.0
nvm use 22.20.0

pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

All four project commands should pass. Current Wrangler versions require Node 22 or newer.

## 2. Authenticate Wrangler

```shell
cd /Users/jasonxu/Documents/personal/skill-secret-share/apps/rendezvous-worker

pnpm exec wrangler login --use-keyring
pnpm exec wrangler whoami
```

`--use-keyring` stores Wrangler credentials using macOS Keychain. If the user belongs to multiple
Cloudflare accounts, verify that `whoami` shows the intended staging account. Do not share or commit
authentication tokens.

See [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/commands/general/).

## 3. Deploy the staging Worker

```shell
pnpm deploy:staging
```

This deploys:

- Worker: `skillspore-rendezvous-staging`
- SQLite Durable Object: `RendezvousSession`
- Durable Object migration: `v1`
- Upgrade, create, and join rate-limit bindings
- Variables from `apps/rendezvous-worker/wrangler.toml`

Cloudflare may ask to enable a `workers.dev` subdomain on the first deployment. Record the resulting
URL, for example:

```text
https://skillspore-rendezvous-staging.<your-subdomain>.workers.dev
```

## 4. Test the basic deployment

Replace the hostname below with the deployed hostname:

```shell
curl -i https://skillspore-rendezvous-staging.<your-subdomain>.workers.dev/healthz
```

Expected response:

```json
{ "ok": true }
```

Verify that ordinary HTTP traffic cannot use the rendezvous endpoint:

```shell
curl -i https://skillspore-rendezvous-staging.<your-subdomain>.workers.dev/v1/rendezvous
```

Expected: HTTP `400` with `WebSocket upgrade required`.

## 5. Create a Cloudflare Realtime TURN key

In the Cloudflare dashboard:

1. Open the staging account.
2. Search for **Realtime** or **TURN**.
3. Open the Realtime TURN section.
4. Create a TURN key.
5. Securely record the TURN Key ID and TURN Key API token.

These are long-lived server credentials used to generate and revoke short-lived peer credentials.
Never put them in source control, send them to clients, or paste them into support conversations.

See [Cloudflare TURN credential management](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

## 6. Add TURN secrets to the staging Worker

From `apps/rendezvous-worker`:

```shell
pnpm exec wrangler secret put TURN_KEY_ID \
  --name skillspore-rendezvous-staging
```

Paste the TURN Key ID at the hidden prompt. Then run:

```shell
pnpm exec wrangler secret put TURN_KEY_API_TOKEN \
  --name skillspore-rendezvous-staging
```

Paste the TURN Key API token at the hidden prompt. Confirm only the secret names:

```shell
pnpm exec wrangler secret list \
  --name skillspore-rendezvous-staging
```

The output should include `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`, but never their values. Wrangler's
`--name` option targets the staging Worker specifically.

See [Wrangler secret commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

## 7. Watch staging logs

Leave this running in a separate terminal:

```shell
cd /Users/jasonxu/Documents/personal/skill-secret-share/apps/rendezvous-worker

pnpm exec wrangler tail skillspore-rendezvous-staging \
  --format pretty
```

Logs must not expose IPs, nameplates, signaling messages, passcodes, credentials, or payload
metadata.

## 8. Test a real transfer

On the sender machine:

```shell
cd /Users/jasonxu/Documents/personal/skill-secret-share

export SKILLSPORE_SERVER_URL='wss://skillspore-rendezvous-staging.<your-subdomain>.workers.dev/v1/rendezvous'

pnpm dev:cli share ./apps/cli/lan-e2e-skill
```

On a second terminal or computer:

```shell
cd /Users/jasonxu/Documents/personal/skill-secret-share

export SKILLSPORE_SERVER_URL='wss://skillspore-rendezvous-staging.<your-subdomain>.workers.dev/v1/rendezvous'

pnpm dev:cli fetch --download-only --output /tmp/skillspore-cloudflare-test
```

Enter the passcode shown by the sender. Both sides should complete successfully.

## 9. Force a TURN transfer

Run both commands again with `--force-relay`:

```shell
pnpm dev:cli share ./apps/cli/lan-e2e-skill --force-relay
```

```shell
pnpm dev:cli fetch \
  --download-only \
  --output /tmp/skillspore-turn-test \
  --force-relay
```

Both clients should report a `relayed` connection. For meaningful validation, run the peers on
different physical networks.

## 10. Attach a staging custom domain

The domain must already be an active Cloudflare zone in the same account.

1. Go to **Workers & Pages**.
2. Select `skillspore-rendezvous-staging`.
3. Open **Settings > Domains & Routes**.
4. Select **Add > Custom Domain**.
5. Enter a hostname such as `rendezvous-staging.example.com`.
6. Select **Add Custom Domain**.

The hostname must not already have a CNAME record. Cloudflare will create the DNS record and issue
the certificate automatically.

See [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

Retest the health endpoint:

```shell
curl https://rendezvous-staging.example.com/healthz
```

Then use the custom hostname for the CLI:

```shell
export SKILLSPORE_SERVER_URL='wss://rendezvous-staging.example.com/v1/rendezvous'
```

## 11. Configure security rules

In the zone dashboard, open **Security > Security rules** or **Security > WAF > Custom rules**.

Create a rule scoped to:

```text
Hostname equals rendezvous-staging.example.com
URI Path equals /v1/rendezvous
```

Start with a rule that blocks non-`GET` methods. Do not apply an interactive Managed Challenge to
valid rendezvous requests because the CLI cannot complete browser challenges.

The application already enforces:

- 120 upgrades per minute per IP and Cloudflare location
- 20 creates per minute per IP and Cloudflare location
- 60 joins per minute per IP and Cloudflare location
- 64 KiB signaling messages
- Per-session burst and lifetime limits
- Five invalid messages per socket

See [Cloudflare WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/).

## 12. Run the staging load test

First change staging to STUN-only mode in `apps/rendezvous-worker/wrangler.toml`:

```toml
TURN_MODE = "stun-only"
```

Redeploy:

```shell
cd /Users/jasonxu/Documents/personal/skill-secret-share/apps/rendezvous-worker
pnpm deploy:staging
```

Run the load test from the repository root:

```shell
cd /Users/jasonxu/Documents/personal/skill-secret-share

pnpm load:rendezvous -- \
  --url wss://rendezvous-staging.example.com/v1/rendezvous \
  --sessions 1000 \
  --creations-per-second 100 \
  --messages-per-session 40
```

This targets:

- 2,000 simultaneous WebSockets
- 1,000 Durable Objects
- 100 session creations per second
- 40 signaling messages per session

After signaling validation, restore:

```toml
TURN_MODE = "best-effort"
```

Redeploy and repeat the direct and forced-relay transfer tests.

## 13. Configure alerts and emergency controls

Configure Cloudflare notifications and billing alerts for:

- Worker and Durable Object warning at 70% of quota
- Internal action at 90% of quota
- TURN warning at 700 GB per month
- TURN stop threshold at 850 GB per month

Emergency actions:

- Stop new sessions: set `SESSIONS_MODE = "disabled"` and redeploy.
- Stop new TURN credentials: set `TURN_MODE = "stun-only"` and redeploy.
- Serious incident: disable the Worker custom domain or deploy a fail-closed Worker.

## 14. Repeat for production

Use the production Cloudflare account, then deploy:

```shell
cd /Users/jasonxu/Documents/personal/skill-secret-share/apps/rendezvous-worker
pnpm deploy:production
```

Configure the production Worker secrets:

```shell
pnpm exec wrangler secret put TURN_KEY_ID \
  --name skillspore-rendezvous

pnpm exec wrangler secret put TURN_KEY_API_TOKEN \
  --name skillspore-rendezvous
```

Attach the final custom domain, such as:

```text
rendezvous.example.com
```

Keep using `SKILLSPORE_SERVER_URL` until every staging acceptance gate passes. Change the compiled
CLI default endpoint only during the final cutover.

For the complete validation, security-drill, monitoring, cutover, and rollback checklist, see
`docs/cloudflare-production-runbook.md`.

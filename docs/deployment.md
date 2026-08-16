# Rendezvous deployment

The production target is the Cloudflare Worker and SQLite-backed `RendezvousSession` Durable Object
in `apps/rendezvous-worker`. The Node service in `apps/rendezvous` remains the local and rollback
reference implementation of the same rendezvous v1 contract.

## Local reference server

Start the Node server with:

```shell
pnpm dev:server
```

It uses Cloudflare STUN by default. `SKILLSPORE_ICE_SERVERS_JSON` can provide an isolated test
configuration, or Twilio credentials can provide distinct short-lived rollback TURN credentials:

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
```

The Node service stores sessions in memory and must remain a singleton. It is not the production
scale architecture.

## Cloudflare configuration

Use Node 22 or newer and authenticate Wrangler against the staging account:

```shell
pnpm install --frozen-lockfile
pnpm --filter @skillspore/rendezvous-worker typecheck
pnpm --filter @skillspore/rendezvous-worker build
pnpm exec wrangler login
```

Create a Cloudflare Realtime TURN key, then configure its long-lived values as Worker secrets:

```shell
cd apps/rendezvous-worker
pnpm exec wrangler secret put TURN_KEY_ID
pnpm exec wrangler secret put TURN_KEY_API_TOKEN
```

Never commit the key or API token. Production supports these modes:

- `SESSIONS_MODE=enabled|disabled` controls whether new upgrades are accepted.
- `TURN_MODE=best-effort` issues TURN credentials and falls back to STUN on provider failure.
- `TURN_MODE=stun-only` stops issuing new relay credentials.
- `TURN_MODE=forced-relay-test` makes missing TURN credentials a retryable staging failure.

Deploy staging and production with the package scripts after defining the corresponding Wrangler
environments or supplying account-specific configuration through CI:

```shell
pnpm --filter @skillspore/rendezvous-worker deploy:staging
pnpm --filter @skillspore/rendezvous-worker deploy:production
```

The public CLI endpoint remains configurable:

```shell
export SKILLSPORE_SERVER_URL=wss://<production-domain>/v1/rendezvous
```

## Required provider controls

- Keep Cloudflare automatic DDoS protection enabled.
- Scope WAF rules to `/v1/rendezvous` and avoid interactive challenges that break CLI upgrades.
- Configure billing and usage alerts at the decision document's warning thresholds.
- Use Cloudflare Security Events and expiring WAF/IP Access rules for temporary IP or ASN blocks;
  do not create an application blacklist.
- At the TURN stop threshold, change `TURN_MODE` to `stun-only` and redeploy.
- For a session emergency, change `SESSIONS_MODE` to `disabled`; for a wider incident, deploy a
  fail-closed Worker or block the custom domain.

Application logs must not contain IP addresses, nameplates, passcodes, signaling bodies, TURN
credentials, or skill metadata. The only per-session event is `session_completed`, containing the
opaque random session ID and completion timestamp.

## Validation and rollout

Run the repository checks and Worker-runtime suite:

```shell
pnpm typecheck
pnpm test
pnpm build
```

Run the signaling load harness against an isolated staging account in `stun-only` mode:

```shell
pnpm load:rendezvous -- \
  --url wss://<staging-domain>/v1/rendezvous \
  --sessions 1000 \
  --creations-per-second 100 \
  --messages-per-session 40
```

Follow [the production runbook](cloudflare-production-runbook.md) for abuse drills, real-network
direct and forced-TURN tests, acceptance metrics, cutover, and rollback. Do not change the CLI
default endpoint until every gate in `cloudflare-production-decision.md` passes.

Keep the Node production deployment for seven days after cutover. Rollback restores the prior CLI
endpoint; no skill contents or active session state require migration. Remove the Node production
deployment after the window, while retaining its source and contract tests.

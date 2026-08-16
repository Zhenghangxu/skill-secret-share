# Cloudflare production rendezvous runbook

This runbook operationalizes the acceptance gates in
`docs/cloudflare-production-decision.md`. Record the Git commit, Wrangler version, Worker deployment
version, Durable Object migration tag, compatibility date, modes, and thresholds for every run.

## Staging preparation

1. Use a Cloudflare account whose free quotas are isolated from production.
2. Create the Realtime TURN key and configure `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` as secrets.
3. Deploy with `SESSIONS_MODE=enabled` and `TURN_MODE=stun-only` for signaling load tests.
4. Verify `/healthz`, the custom staging hostname, Workers Logs, Durable Object analytics, and
   endpoint-scoped Security Events.
5. Confirm invalid or absent subprotocols return HTTP 400, unavailable nameplates return 404,
   occupied nameplates return 409, throttles return 429 with `Retry-After`, and disabled sessions
   return 503.

## Signaling and abuse load

Run the 1,000-session workload:

```shell
pnpm load:rendezvous -- \
  --url wss://<staging-domain>/v1/rendezvous \
  --sessions 1000 \
  --creations-per-second 100 \
  --messages-per-session 40
```

Run a mixed abuse pass by adding `--abuse-sessions 1000`. Use scaled staging thresholds when testing
rate and lifetime failures; do not intentionally exhaust the account's real daily quotas.

Capture connection success, create/join and relay latency percentiles, Worker/DO errors, rejection
counts, CPU time, request and SQLite row usage, alarm cleanup, and the percentage of rejections that
occurred before Durable Object allocation. Compare every result with the objectives in the decision
document.

## Real-network WebRTC matrix

Use at least two machines on different networks. Build a synthetic skill containing 25 MiB or less
of deterministic data and verify its manifest hashes after every transfer.

1. Set `TURN_MODE=best-effort`; run normal `skillspore share` and `skillspore fetch` commands without
   `--force-relay`. Record both peers' candidate-pair types. At least 80% of representative transfers
   must avoid relay candidates.
2. Keep `TURN_MODE=best-effort` and run both commands with `--force-relay`. Verify payload hashes and
   confirm relay candidate pairs.
3. Scale the forced-relay test to 50 concurrent 25 MiB transfers across the two network groups. At
   least 98% must finish and pass hash verification.
4. Set `TURN_MODE=forced-relay-test`, temporarily deny the credential provider in staging, and verify
   clients receive retryable failures with at most three jittered retries.
5. Restore `best-effort`, confirm new sessions work, and verify every completed credential username
   receives a revocation attempt.

## Security and emergency drills

- Send binary, oversized, obsolete `create`/`join`, malformed signaling, and per-session flood
  traffic. Confirm only the responsible socket/object is closed with policy code 1008.
- Hibernate waiting objects, wake them with messages, and verify roles and message counters survive.
- Exercise waiting and connected alarms, abrupt sender/receiver disconnects, repeated wrong
  passcodes, partial TURN generation, revocation timeout, and repeated cleanup.
- Add a temporary WAF or IP Access block with an owner, reason, and expiry. Confirm it blocks the
  selected source before Worker allocation, then remove it and confirm access returns without a
  deployment.
- Set `SESSIONS_MODE=disabled` and verify new upgrades fail closed while existing transfers finish.
- Set `TURN_MODE=stun-only` and verify new paired sessions contain no TURN credentials.
- Test the documented fail-closed Worker/domain procedure.

## Privacy-safe TURN fallback report

Within one Workers Logs retention window:

1. Export opaque session IDs from `session_completed` events.
2. Query Cloudflare TURN GraphQL analytics for distinct `customIdentifier` values with nonzero egress
   in the same interval.
3. Intersect the two sets and calculate:

```text
TURN fallback rate = completed IDs with TURN egress / completed IDs
direct transfer rate = 1 - TURN fallback rate
```

Do not export IPs, nameplates, signaling data, credentials, or payload metadata.

## Cutover and rollback

1. Obtain independent protocol and cryptographic review approval.
2. Pass every decision-document gate, then deploy production and attach the real custom domain.
3. Release a CLI tested against both Node and Worker implementations.
4. Change the CLI default endpoint while preserving `--server` and `SKILLSPORE_SERVER_URL`.
5. Monitor errors, quotas, TURN fallback, egress, and abuse for seven days.
6. If rollback is required, restore the previous CLI endpoint and keep the Worker fail-closed.
7. After seven healthy days, remove the Railway/Twilio deployment but retain the Node reference
   source and shared contract tests.

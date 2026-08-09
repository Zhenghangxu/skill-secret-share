# Cloudflare production architecture decision

- Status: Accepted as the target architecture; implementation and load validation are required
  before production rollout.
- Date: 2026-08-08
- Scope: The shared SkillSpore service used by all organizational senders and receivers.
- Supersedes: `docs/vendor-switch-decision.md` and its Oracle single-VM pilot architecture.

## Decision

SkillSpore will target Cloudflare Workers and Durable Objects for its organization-wide rendezvous
service. Cloudflare Realtime STUN/TURN will provide NAT traversal.

The decision is driven by these requirements:

- approximately 10,000 simultaneous users, or 5,000 sender/receiver sessions;
- many independent sender and receiver computers;
- no client computer in the production hosting path;
- globally reachable secure WebSockets;
- horizontal coordination without managing virtual machines;
- a strong preference for a $0 bill; and
- an explicit choice between guaranteed-$0 STUN-only operation and usage-billed TURN fallback.

This decision requires rewriting the current Node.js `ws` rendezvous service. The transfer,
protocol, PAKE, WebRTC, installer, and CLI behavior should remain compatible.

Cloudflare Tunnel is not part of this architecture.

## Architecture

```text
organizational sender CLIs ───┐
                              ├── Cloudflare Worker ── Durable Object per session
organizational receiver CLIs ─┘                           │
                                                         ├── signaling relay
                                                         └── short-lived TURN credentials

skill payload: sender ═════════ direct WebRTC or Cloudflare TURN ═════════ receiver
```

The Worker provides:

- the public HTTPS and WSS endpoint;
- organizational authentication;
- health responses;
- session-nameplate allocation;
- rate and quota enforcement; and
- routing to the Durable Object that owns a session.

Each Durable Object owns one rendezvous session and normally contains exactly two WebSockets: one
sender and one receiver. It handles:

- the waiting and connected expiration timers;
- session ID and nameplate state;
- PAKE share relay;
- WebRTC description and ICE candidate relay;
- failed authentication attempt tracking;
- session completion and cleanup; and
- WebSocket hibernation while waiting.

The rendezvous layer never receives skill contents or the passcode secret.

## Why this can fit the free tier

Cloudflare currently allows Durable Objects on the Workers Free plan. The platform supports an
unlimited number of Durable Object instances, and the WebSocket Hibernation API can keep sockets
connected without continuously running JavaScript. See:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/api/state/)

A representative 10,000-user event is approximately:

| Resource                                            |                            Estimate |
| --------------------------------------------------- | ----------------------------------: |
| Concurrent users                                    |                              10,000 |
| Concurrent transfer sessions                        |                               5,000 |
| Durable Object instances                            |                               5,000 |
| WebSockets per session object                       |                                   2 |
| Initial Worker WebSocket requests                   |                approximately 10,000 |
| Initial Durable Object connection requests          |                approximately 10,000 |
| Session expiration/completion alarms                |                 approximately 5,000 |
| Nameplate reservation collisions at 0.5% occupancy  |                  expected to be low |
| Maximum skill payload per transfer                  |                              25 MiB |
| Expected TURN egress at a 15% fallback rate         | approximately 19.7 GB plus overhead |
| Worst-case TURN egress if all 5,000 transfers relay |  approximately 131 GB plus overhead |

The 15% planning estimate comes from Twilio's statement that STUN succeeds around 85% of the time.
It is not a guarantee and may be worse on corporate VPNs or restrictive enterprise firewalls. See
[Twilio STUN/TURN](https://www.twilio.com/en-us/stun-turn).

The request estimate above is incomplete without signaling traffic. Capacity planning must also
include:

- PAKE shares, SDP, and ICE candidates;
- authentication and schema validation;
- retries and reconnects;
- rejected nameplate reservations;
- WebSocket close events; and
- quota and observability operations.

For planning, assume at least 40 incoming signaling messages per session until production telemetry
provides a better number. At 5,000 sessions, that is 200,000 raw incoming WebSocket messages. Under
Cloudflare's current 20:1 Durable Object WebSocket-message billing ratio, that represents about
10,000 additional billed requests. This assumption must be replaced with measured results.

Workers Free currently limits CPU to 10 milliseconds per invocation. Organizational token
validation, runtime schemas, and routing must be benchmarked against that limit rather than assumed
to fit.

Cloudflare Realtime TURN currently includes 1,000 GB per month before paid usage, while its STUN
service is free and unlimited. See the
[Cloudflare Realtime TURN pricing FAQ](https://developers.cloudflare.com/realtime/turn/faq/).

These calculations are estimates, not capacity proof. Production approval requires the load tests
defined below.

## Cost modes and quota behavior

Cloudflare Workers Free and Durable Objects Free fail closed when their daily request quotas are
exhausted. Cloudflare Realtime TURN is different: its free allowance is followed by usage billing.
Cloudflare budget alerts are informational, are not real-time hard caps, and do not stop usage.
Already-issued TURN credentials may continue generating traffic after the application stops issuing
new credentials.

Therefore, the architecture must expose two explicit operating modes.

### Guaranteed-$0 mode

- Use Workers Free and Durable Objects Free.
- Return Cloudflare's free STUN configuration only.
- Do not provision TURN secrets or enable Cloudflare Realtime TURN.
- Accept that direct WebRTC will fail for some users behind restrictive NATs and firewalls.
- Let Cloudflare fail closed when the Worker or Durable Object daily quota is exhausted.

This is the only mode in this design that can honestly guarantee a $0 provider bill.
It does not include unrelated costs such as domain registration or the organization's identity
provider. A `workers.dev` hostname can be used when even a custom-domain cost is unacceptable.

### Best-effort free-TURN mode

- Enable Cloudflare Realtime TURN and accept that usage beyond the free allowance is billable.
- Track issued session credentials and Cloudflare TURN analytics.
- Use a conservative per-session allowance greater than the maximum 25 MiB skill size to account
  for WebRTC and TURN overhead.
- Stop issuing new TURN credentials well before the estimated free allowance is consumed.
- Use short credential lifetimes and revoke credentials when a session completes or is cancelled.
- Configure billing alerts, while recognizing that alerts do not cap spend.
- Fall back to STUN-only sessions after the internal TURN allowance is exhausted.

Credential counting reduces risk but cannot guarantee a $0 bill because a compromised or malicious
credential can consume more bandwidth than the expected skill transfer. If any paid overage is
unacceptable, use guaranteed-$0 mode.

Suggested operational thresholds:

| Resource                              | Warning | Internal stop |
| ------------------------------------- | ------: | ------------: |
| Daily Worker request estimate         |     70% |           90% |
| Daily Durable Object request estimate |     70% |           90% |
| Monthly TURN analytics                |  700 GB |        850 GB |

The internal counters are protective estimates, not authoritative provider billing data.
Thresholds must be updated whenever Cloudflare changes its limits or pricing.

## Session routing design

### Nameplates

The existing protocol uses four-digit nameplates, providing only 10,000 possible values. That is too
close to the target scale: 5,000 simultaneous sessions would occupy half of the namespace and make
collision behavior an unnecessary production risk.

The Cloudflare migration will expand newly-created nameplates to six digits, providing 1,000,000
values. During migration, clients must accept both legacy four-digit and new six-digit nameplates;
the Worker emits only six-digit nameplates.

The Worker should:

1. generate a random six-digit nameplate;
2. address the Durable Object derived from that nameplate;
3. ask the object to atomically reserve itself if empty;
4. retry with another nameplate when occupied; and
5. return service-unavailable after a bounded number of attempts.

Do not use a single global allocator Durable Object; it would create an avoidable serialization
point during large session-creation bursts.

Reservation retries must be bounded and covered by concurrent allocation tests.

### Durable Object lifecycle

Use a SQLite-backed Durable Object class because that is the storage backend available on the free
plan.

Each object should store only the minimum data needed to recover lifecycle state:

- session ID;
- role occupancy;
- expiration timestamp;
- failed-attempt count; and
- completion state.

Do not persist PAKE shares, SDP, ICE candidates, TURN credentials, passcodes, or skill metadata.

Use Durable Object alarms for waiting and connected expiration. Use the WebSocket Hibernation API
and serialized WebSocket attachments to recover sender/receiver roles after hibernation.

Alarm handlers must be idempotent because Durable Object alarms have at-least-once execution.
Completion, expiration, cancellation, and abandoned reservation cleanup must:

1. close both WebSockets;
2. clear serialized attachments and in-memory role state; and
3. call `ctx.storage.deleteAll()`.

With the selected compatibility date, `deleteAll()` also removes the active alarm. Without this
explicit cleanup, SQLite and alarm metadata remain and consume the free storage allowance.

### Protocol compatibility

The public endpoint remains:

```text
wss://rendezvous.example.org/v1/rendezvous
```

The Worker implementation must preserve the existing `ClientRendezvousMessage` and
`ServerRendezvousMessage` formats unless a versioned protocol migration is intentionally approved.

## Organizational authentication

The current anonymous rendezvous protocol is not appropriate for an organization-wide public
endpoint because it allows outsiders to consume session capacity and mint TURN credentials.

Before rollout:

- require a short-lived organizational access token on every WebSocket upgrade;
- use the organization's OIDC provider and device authorization flow;
- validate issuer, audience, expiration, signature, and organizational membership at the Worker
  edge;
- fetch and cache the provider's JWKS and support signing-key rotation;
- add CLI support for obtaining and refreshing the token;
- store local tokens through the operating system's secure credential facility;
- never place the access token inside the one-time transfer passcode; and
- apply per-user, per-device, per-organization, and global session limits.

The deployment should support revoking a user or device without changing the rendezvous protocol
for everyone else.

## TURN design

Use Cloudflare Realtime TURN with short-lived credentials generated by the Worker. Keep the TURN
key and API token in Cloudflare secrets and never send them to clients.

Follow the
[Cloudflare credential-generation documentation](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

The Worker should request or generate credentials only after:

- the organizational identity is authenticated;
- the session reservation succeeds;
- rate limits pass; and
- the TURN free-budget guard permits issuance.

Add a supported deployment-test option that forces WebRTC `iceTransportPolicy: "relay"`. A
production release is not validated until forced relay succeeds between machines on different
networks.

## Proposed project structure

The current Node rendezvous application should remain during migration as the compatibility
reference.

```text
apps/
  rendezvous/                 # existing Node reference server
  rendezvous-worker/          # Cloudflare Worker and Durable Object implementation
packages/
  protocol/                   # shared message types and validation schemas
  transport/                  # client rendezvous and WebRTC transport
```

The new Worker package should contain:

```text
apps/rendezvous-worker/
  src/worker.ts
  src/session-object.ts
  src/auth.ts
  src/limits.ts
  src/turn.ts
  src/validation.ts
  wrangler.toml
  package.json
```

Move runtime message validation into a platform-neutral protocol package so both the Node server
and Worker use identical validation.

## Wrangler configuration outline

The final values must be checked against the current Wrangler schema during implementation.

```toml
name = "skillspore-rendezvous"
main = "src/worker.ts"
compatibility_date = "2026-08-08"

[[durable_objects.bindings]]
name = "SESSIONS"
class_name = "RendezvousSession"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RendezvousSession"]

[vars]
WAITING_TTL_SECONDS = "600"
CONNECTED_TTL_SECONDS = "900"
MAX_FAILED_ATTEMPTS = "5"
TURN_MODE = "stun-only"
OIDC_ISSUER = "https://identity.example.org"
OIDC_AUDIENCE = "skillspore-rendezvous"
```

Secrets must be configured through Wrangler or the Cloudflare dashboard, never committed:

```shell
pnpm exec wrangler secret put TURN_KEY_ID
pnpm exec wrangler secret put TURN_KEY_API_TOKEN
```

Provision the TURN secrets only for best-effort free-TURN mode. Guaranteed-$0 mode must not have
usable TURN credentials configured.

OIDC issuer and audience are non-secret configuration. The Worker should retrieve signing keys from
the issuer's JWKS endpoint rather than relying on one static `ORG_TOKEN_VERIFICATION_KEY` secret.

## Deployment instructions

These commands apply after `apps/rendezvous-worker` has been implemented.

### 1. Authenticate and validate

```shell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm exec wrangler login
```

### 2. Create TURN credentials

Create a Cloudflare Realtime TURN key in the Cloudflare dashboard or API. Store the resulting token
identifier and API token as Worker secrets. Do not put them in `[vars]`.

### 3. Deploy a staging Worker

```shell
pnpm --filter @skillspore/rendezvous-worker deploy:staging
```

Verify:

```shell
curl --fail https://<staging-worker-domain>/healthz
```

Run protocol contract tests, direct transfer tests, forced TURN tests, authentication tests, and
quota-failure tests against staging.

Staging and production should use separate Cloudflare accounts when free-quota isolation is
required. Separate Workers or TURN keys inside one account do not create separate account-level
free allowances. A full 10,000-user staging load test must not consume the quotas required by
production.

### 4. Configure the production domain

Attach `rendezvous.example.org` as the Worker custom domain and verify:

```shell
curl --fail https://rendezvous.example.org/healthz
```

Configure the Worker route to fail closed when the Workers Free daily request limit is exceeded.
Fail-open routing would bypass the authentication and rendezvous logic and is not acceptable.

The production CLI configuration is:

```shell
export SKILLSPORE_SERVER_URL=wss://rendezvous.example.org/v1/rendezvous
```

### 5. Deploy production

```shell
pnpm --filter @skillspore/rendezvous-worker deploy:production
```

Record:

- Git commit;
- Wrangler version;
- Worker deployment version;
- Durable Object migration tag;
- compatibility date; and
- active free-quota thresholds.

Durable Object migrations must be forward-compatible. Do not use a destructive migration that
would make the previous Worker version unable to run. For incompatible changes, deploy a new
Durable Object class and migrate traffic gradually rather than assuming a Worker code rollback also
rolls back stored state.

## Migration from the Node server

1. Add runtime schemas for every rendezvous and signaling message.
2. Build the Worker implementation against those schemas.
3. Run the same protocol contract suite against Node and Cloudflare implementations.
4. Deploy the Worker to a staging hostname.
5. Test sender and receiver CLIs across different networks.
6. Run forced direct and forced TURN transfers.
7. Load-test the staging service.
8. Configure the production custom domain.
9. Change the organizational CLI default endpoint.
10. Keep the Node deployment available only for rollback during a defined migration window.
11. Remove the Node production deployment after the rollback window closes.

No skill contents or active rendezvous sessions need data migration.

## Load-test requirements

Production approval requires a test that reaches or exceeds:

- 10,000 simultaneous authenticated WebSockets;
- 5,000 simultaneous session Durable Objects;
- the expected peak session-creation rate plus a safety margin;
- realistic PAKE, SDP, and ICE candidate message counts;
- 5,000 orderly session completions;
- abrupt sender and receiver disconnects;
- Durable Object hibernation and wake-up;
- expiration alarms at scale;
- incorrect passcodes and failed-attempt enforcement;
- Worker and Durable Object free-quota thresholds; and
- forced TURN transfers sized to the organization's expected workload.

Measure:

- WebSocket connection success rate;
- create and join latency percentiles;
- relay message latency percentiles;
- Durable Object overload responses;
- CPU time per Worker and WebSocket message;
- reconnect behavior;
- request-quota consumption;
- TURN egress; and
- cleanup correctness after the test.

## Production acceptance gates

- Authentication is required and externally reviewed.
- Runtime schemas reject malformed messages without terminating unrelated sessions.
- The 10,000-user load test passes the defined service objectives.
- Direct and forced TURN transfers pass between multiple real networks.
- Workers and Durable Objects fail closed at their free limits and are covered by tests.
- The selected TURN operating mode is documented and approved: guaranteed-$0 STUN-only or
  best-effort free TURN with possible overage.
- TURN credentials are short-lived and cannot be minted anonymously.
- Logs exclude passcodes, PAKE shares, SDP, ICE candidates, TURN credentials, and skill metadata.
- Alerts exist for authentication failures, quota thresholds, Durable Object errors, and TURN
  usage.
- Deployment and rollback procedures are tested.
- The protocol and cryptographic design receive an independent security review before sensitive
  organizational use.

## Consequences

### Benefits

- No VM or container fleet to operate.
- No single rendezvous process or host.
- Session state naturally partitions across Durable Objects.
- WebSocket hibernation is well matched to short-lived, mostly idle rendezvous sessions.
- Global WSS ingress and DDoS protection are provided by Cloudflare.
- The estimated single-event launch workload may fit within current free allowances, subject to
  load testing and reconnect frequency.

### Costs and risks

- The rendezvous server must be rewritten.
- The organization becomes dependent on Cloudflare Workers, Durable Objects, and Realtime TURN.
- Free limits can change.
- Free quotas provide no unlimited-capacity or availability guarantee.
- Workers and Durable Objects fail when free quotas are exceeded; TURN can incur overage unless it
  is disabled.
- Sustained organizational usage may eventually require a paid plan even if the initial event fits
  the free tier.

## Review triggers

Revisit this decision when:

- daily free request limits are regularly approached;
- monthly TURN usage approaches 700 GB;
- organizational availability requirements require an SLA;
- Cloudflare changes free-tier availability or pricing;
- regulatory or data-residency requirements cannot be met;
- load testing disproves the capacity assumptions; or
- the engineering cost of the Worker rewrite exceeds an approved paid-hosting budget.

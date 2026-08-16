# Cloudflare production architecture decision

- Status: Accepted as the target architecture; implementation and load validation are required
  before production rollout.
- Date: 2026-08-09
- Scope: The shared public SkillSpore service used by any sender and receiver.
- Target: Approximately 2,000 simultaneous users, or 1,000 sender/receiver sessions.
- Supersedes: The historical vendor-switch decision and its Oracle single-VM pilot architecture.
- Authority: This document is the normative future-state plan. When it differs from the current
  source code or other documentation, this document defines the intended next implementation until
  it is superseded or amended. Current code and documentation remain migration and compatibility
  references.

## Non-negotiable principles

### Direct transfer is the default data path

The vast majority of skill-file traffic must travel directly between the sender and receiver over a
WebRTC DataChannel. The Cloudflare Worker and Durable Object are signaling infrastructure only and
must never proxy, buffer, inspect, or store skill payload bytes.

Cloudflare Realtime TURN is a fallback for networks where direct ICE candidates cannot connect. It
is not the preferred transfer path. Production clients must use `iceTransportPolicy: "all"`; the
`"relay"` policy is permitted only through an explicit test option.

When TURN is required, payload traffic passes through Cloudflare's managed Realtime TURN service,
not through the SkillSpore Worker or Durable Object. The launch objective is that at least 80% of
successful transfers avoid TURN entirely and remain peer-to-peer.

The implementation must preserve these invariants:

- skill payloads use a direct host or server-reflexive ICE candidate whenever WebRTC can establish
  one;
- the Worker and Durable Object accept signaling JSON only;
- signaling messages remain bounded at 64 KiB and binary WebSocket messages are rejected;
- no HTTP upload, object-storage fallback, reverse-proxy transfer, or server-side package cache is
  added; and
- TURN usage is measured as a fallback rate, with at least 80% direct transfers as the launch
  objective in representative multi-network testing.

### Simplicity takes priority over the original scale target

No-over-engineering is a hard requirement. The launch target is therefore 1,000 simultaneous
sessions instead of 5,000.

The initial architecture intentionally does not include:

- a global allocator or quota Durable Object;
- sharded counters or distributed leases;
- Workers KV, D1, Queues, or Analytics Engine;
- a scheduled analytics reconciliation job;
- a second rendezvous protocol version;
- automatic cross-provider failover; or
- a custom global cost-accounting system;
- a server-side waiting queue for anonymous requests; or
- an application-managed IP blacklist database.

The service uses one Durable Object per rendezvous session, Worker Rate Limiting bindings for
best-effort edge abuse controls, provider quotas that fail closed, short-lived TURN credentials, and
Cloudflare's built-in usage and billing views. Additional infrastructure requires evidence from the
review triggers at the end of this decision.

## Decision

SkillSpore will target Cloudflare Workers and Durable Objects for a public rendezvous service that
does not require an organization account or access token. Cloudflare Realtime STUN/TURN will provide
NAT traversal.

This decision is driven by these requirements:

- approximately 2,000 simultaneous users, or 1,000 sender/receiver sessions;
- many independent sender and receiver computers;
- no client computer in the production hosting path;
- globally reachable secure WebSockets;
- direct peer-to-peer transfer whenever network conditions allow;
- no virtual machines or container fleet to manage;
- direct public access without organizational authentication; and
- best-effort cost controls that aim to keep provider spend below $2 per month without treating that
  amount as a guaranteed hard cap.

This requires rewriting the current Node.js `ws` rendezvous service for Workers and Durable Objects.
Because the application has not launched, this decision finalizes rendezvous v1 rather than
preserving the prototype handshake. Four-digit nameplates, PAKE, WebRTC transfer, installer behavior,
and the user-facing CLI workflow remain compatible, while the WebSocket upgrade and message schemas
change as defined below.

Cloudflare Tunnel is not part of this architecture.

## Architecture

```text
sender CLIs ───┐
               ├── Cloudflare Worker ── Durable Object per session
receiver CLIs ─┘                           │
                                          └── signaling relay only

preferred payload path: sender ═════════ direct WebRTC ═════════ receiver
fallback payload path:  sender ═══════ Cloudflare Realtime TURN ═══════ receiver
```

The Worker provides:

- the public HTTPS and WSS endpoint;
- anonymous WebSocket access with edge abuse controls;
- health responses;
- random four-digit nameplate allocation;
- Worker Rate Limiting checks; and
- routing to the Durable Object that owns the selected nameplate.

Each `RendezvousSession` Durable Object owns one session and normally contains two WebSockets: one
sender and one receiver. It handles:

- waiting and connected expiration timers;
- session ID and nameplate state;
- PAKE share relay;
- WebRTC description and ICE candidate relay;
- failed-attempt tracking;
- TURN revocation identifiers;
- session completion and cleanup; and
- WebSocket hibernation while waiting.

The rendezvous layer never receives skill contents, skill metadata, the passcode secret, or the
derived transfer key.

## Capacity and cost model

Cloudflare currently allows SQLite-backed Durable Objects on the Workers Free plan. WebSocket
hibernation permits waiting sockets to remain connected without continuously running JavaScript.
See:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/api/state/)

A representative 1,000-session event is approximately:

| Resource                                      |                            Estimate |
| --------------------------------------------- | ----------------------------------: |
| Concurrent users                              |                               2,000 |
| Concurrent transfer sessions                  |                               1,000 |
| Session Durable Objects                       |                               1,000 |
| WebSockets per session object                 |                                   2 |
| Initial Worker WebSocket requests             |                 approximately 2,000 |
| Initial Durable Object connection requests    |                 approximately 2,000 |
| Session expiration/completion alarms          |                 approximately 1,000 |
| Incoming signaling messages                   |                approximately 40,000 |
| Billed signaling requests at the 20:1 ratio   |                 approximately 2,000 |
| Normal-path SQLite rows written               |  target at most 6,000, or 6/session |
| TURN credential-generation calls              |                       at most 2,000 |
| Four-digit nameplate occupancy                |                                 10% |
| Maximum skill payload per transfer            |                              25 MiB |
| Expected TURN egress at a 15% fallback rate   |  approximately 3.9 GB plus overhead |
| Worst-case TURN egress if all transfers relay | approximately 26.2 GB plus overhead |

The 15% planning estimate comes from Twilio's statement that STUN succeeds around 85% of the time.
It is not a guarantee and may be worse on corporate VPNs or restrictive enterprise firewalls. See
[Twilio STUN/TURN](https://www.twilio.com/en-us/stun-turn).

The initial workload envelope is:

- at most 1,000 simultaneous sessions;
- 100 successful session creations per second for ten seconds;
- approximately 2,000 newly-created sessions on a busy UTC day;
- at least 40 incoming signaling messages per completed session for planning;
- a maximum transfer size of 25 MiB;
- 15% expected TURN fallback, with 30% used for cost-sensitivity testing; and
- a 20-minute TURN credential TTL, covering the 15-minute connected TTL and a cleanup margin.

The concurrency and daily figures are validation targets, not application-enforced global limits.
The initial implementation deliberately relies on local rate limits and provider quotas rather than
building distributed admission accounting.

SQLite capacity planning must include session-state writes, alarm creation and replacement,
failed-attempt updates, stored TURN usernames, and cleanup deletions. The normal path must use one
compact session row and remain at or below six total rows written per session. Load testing must
measure the actual value.

Workers Free currently limits CPU to 10 milliseconds per invocation. Runtime schemas, rate-limit
checks, and routing must be benchmarked against that limit.

Cloudflare Realtime TURN currently includes 1,000 GB per month before paid usage, while STUN is free
and unlimited. See the
[Cloudflare Realtime TURN pricing FAQ](https://developers.cloudflare.com/realtime/turn/faq/).

These calculations are estimates, not capacity proof. Production approval requires the load tests
defined below.

## Cost strategy and quota behavior

Cloudflare Workers Free and Durable Objects Free fail closed when their daily quotas are exhausted.
Realtime TURN instead moves from its included allowance to usage billing. Cloudflare budget alerts
are informational and do not stop usage. Already-issued TURN credentials may generate traffic until
they expire or are revoked.

The initial cost strategy is intentionally simple:

- use Workers Free and Durable Objects Free;
- enable Realtime TURN as a best-effort fallback;
- use a distinct short-lived TURN credential for each peer;
- attempt credential revocation when a session completes or is cancelled;
- configure Cloudflare billing and usage alerts;
- review Cloudflare's built-in TURN analytics instead of building a custom usage pipeline;
- switch `TURN_MODE` to `stun-only` and redeploy when usage approaches the internal stop threshold;
- let Workers and Durable Objects fail closed at their provider quotas; and
- review this decision before enabling a paid Workers or Durable Objects plan.

The operational target is less than $2 in Cloudflare provider spend per month. It is an optimization
goal, not a hard cap. A malicious or compromised credential can use more relay bandwidth than one
skill transfer before manual controls take effect.

Suggested operational thresholds:

| Resource                               | Warning | Internal action |
| -------------------------------------- | ------: | --------------: |
| Daily Worker request estimate          |     70% |             90% |
| Daily Durable Object request estimate  |     70% |             90% |
| Daily Durable Object SQLite row writes |  70,000 |          90,000 |
| Monthly TURN analytics                 |  700 GB |          850 GB |
| Observed TURN fallback rate            |     20% |             30% |

At 700 GB, review recent usage and abuse signals. At 850 GB, switch new sessions to STUN-only mode.
If the TURN fallback rate exceeds 30% in representative use, investigate client ICE configuration
and network mix before adding infrastructure.

Thresholds must be rechecked whenever Cloudflare changes its pricing or limits.

## Session routing and lifecycle

### Four-digit nameplates

Rendezvous v1 uses four-digit nameplates, providing 10,000 values. At the reduced 1,000-session
target, the namespace is only 10% occupied and does not justify a protocol migration.

Routing information is supplied as a WebSocket subprotocol during the upgrade so the Worker can
select the owning Durable Object before the socket is accepted without putting a nameplate in the
URL:

```text
Sec-WebSocket-Protocol: skillspore.v1.sender
Sec-WebSocket-Protocol: skillspore.v1.receiver.1234
```

The accepted response must echo the selected subprotocol as required by WebSocket negotiation.
Missing, multiple, or malformed SkillSpore subprotocol values are rejected before Durable Object
allocation.

For a sender upgrade, the Worker should:

1. generate a random four-digit nameplate;
2. address the Durable Object derived from that nameplate;
3. proxy the upgrade request and ask the object to atomically reserve itself if empty;
4. retry the upgrade against another nameplate object when it returns occupied; and
5. return service-unavailable after 20 unsuccessful attempts.

For a receiver upgrade, the Worker extracts and validates the four-digit nameplate from the
subprotocol, applies the join rate limit, and proxies the upgrade directly to that nameplate's
Durable Object. Missing, expired, or occupied sessions reject the HTTP upgrade without accepting a
WebSocket.

Do not create a global nameplate allocator. Reservation retries must be covered by concurrent
allocation tests.

### Durable Object state

Use one SQLite-backed `RendezvousSession` class. Each object stores only:

- session ID;
- role occupancy;
- expiration timestamp;
- failed-attempt count;
- completion state; and
- issued TURN usernames, key ID, and expiration timestamps.

Do not persist PAKE shares, SDP, ICE candidates, TURN credential secrets, passcodes, skill metadata,
or skill contents. TURN usernames are non-secret identifiers required for revocation. Generated
credential secrets are sent once to the corresponding client and discarded.

Use Durable Object alarms for waiting and connected expiration. Use WebSocket hibernation and
serialized attachments to recover sender and receiver roles after hibernation.

Alarm handlers and cleanup must be idempotent. Completion, expiration, and cancellation should:

1. close both WebSockets;
2. attempt to revoke persisted TURN usernames with a bounded timeout;
3. clear serialized attachments and in-memory role state; and
4. call `ctx.storage.deleteAll()`.

Revocation is best effort. A failure must produce an aggregate provider-error metric but must not
block cleanup; credential expiration is the final containment boundary.

### Rendezvous v1 final schema

The production endpoint path remains:

```text
wss://rendezvous.example.org/v1/rendezvous
```

The negotiated subprotocol determines whether the connection creates or joins a session. There are
no WebSocket `create` or `join` client messages.

The final v1 messages are:

- `ClientRendezvousMessage`: `relay`, `attempt-failed`, and `complete`;
- `created`: `nameplate`, `sid`, and `expiresAt`;
- `joined`: `nameplate`, `sid`, and `expiresAt`;
- `paired`: a role-specific `iceServers` array generated after both WebSockets are present;
- `relay`, `peer-left`, and `error` retain their existing meanings; and
- `error` includes optional `retryAfterMs` for transient `rate-limited` or `service-unavailable`
  failures.

The sender and receiver receive distinct TURN credentials in their respective `paired` messages.
The client waits for `paired`, then constructs the `RTCPeerConnection` with that message's
`iceServers`. Neither peer receives TURN credentials while the session is unpaired.

Update the Node reference server, Worker, shared runtime schemas, transport client, tests, and
protocol documentation to this final v1 contract in the same implementation change. No legacy
prototype handshake or compatibility mode is required because the application has not launched.

No standalone credential endpoint is permitted.

## Public access and abuse controls

The endpoint is intentionally public. The one-time transfer passcode and PAKE protocol authorize a
specific transfer; they are not a general account system.

Before rollout:

- accept anonymous WebSocket upgrades without an organizational login flow;
- apply a per-IP WebSocket-upgrade throttle before allocating a Durable Object;
- use Worker Rate Limiting bindings for location-local per-IP create and join throttles;
- enforce failed-attempt limits inside each session Durable Object;
- enforce per-socket and per-session signaling message limits;
- bound nameplate reservation retries and invalid-message counts;
- use Cloudflare-provided abuse signals where available without requiring an interactive browser
  challenge for CLI users;
- retain no custom IP-address database and do not log client IP addresses or nameplates;
- support `SESSIONS_MODE=disabled` to reject new sessions after a deployment; and
- document a provider-level emergency procedure that deploys a fail-closed Worker response or blocks
  the custom domain.

Worker Rate Limiting counters are local and approximate. They are abuse mitigations, not billing or
global-concurrency accounting. See the
[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

### Layered DDoS and misuse response

Use the smallest control at the earliest layer that can reject the traffic:

1. **Cloudflare network:** Keep Cloudflare's automatic DDoS managed protection enabled. It should
   absorb volumetric and protocol attacks before they reach Worker code. See
   [Cloudflare DDoS Protection](https://developers.cloudflare.com/ddos-protection/).
2. **WAF and security rules:** Apply a zone rule scoped to `/v1/rendezvous` for obvious malicious
   upgrade traffic. Use Cloudflare Security Events during an incident to identify abusive IPs or
   ASNs. See [Cloudflare WAF](https://developers.cloudflare.com/waf/).
3. **Worker upgrade throttle:** Before accepting a WebSocket, limit each IP to 120 upgrades per
   minute per Cloudflare location. Rejected HTTP upgrades return `429` with `Retry-After`.
4. **Create and join throttles:** Limit each IP to 20 creates and 60 joins per minute per Cloudflare
   location. Because role and nameplate are available during the upgrade, rejected creates and joins also
   return HTTP `429` before a Durable Object accepts the socket.
5. **Session isolation:** Each accepted socket has the immutable sender or receiver role supplied by
   its upgrade request. A session permits no more than 20 signaling messages per second with a burst
   of 50, no more than 200 signaling messages over the session lifetime, and no more than five
   invalid messages per socket. Obsolete `create` or `join` messages are invalid. Exceeding a limit
   closes only that socket or session with WebSocket code `1008` (`Policy Violation`) and must not
   affect unrelated Durable Objects.
6. **Emergency controls:** Set `SESSIONS_MODE=disabled` to reject new sessions, set
   `TURN_MODE=stun-only` to stop issuing relay credentials, or deploy a fail-closed Worker response.

Keep burst, invalid-message, and lifetime-message counters in memory and serialized WebSocket
attachments. Do not perform a SQLite write for each signaling message.

Do not queue untrusted requests in application storage. Durable Objects may serialize operations for
their own session, but overload and rate-limit responses must fail fast. The CLI handles temporary
rejection with exponential backoff and full jitter: start at 500 milliseconds, cap each delay at five
seconds, and attempt at most three retries. A server-provided `Retry-After` or `retryAfterMs` value
takes precedence. This prevents a retry storm without creating a server-side queue.

The CLI retries only HTTP `429`, v1 `rate-limited` or `service-unavailable` errors, and WebSocket close
code `1013` (`Try Again Later`). It must not retry policy violations, malformed messages, failed
passcode attempts, or other permanent session errors.

Use Cloudflare WAF custom rules or IP Access rules for temporary blacklisting of a confirmed abusive
IP or ASN. See [IP Access rules](https://developers.cloudflare.com/waf/tools/ip-access-rules/). Every
manual block must include a reason, an owner, and an expiration or review time. Remove the rule when
the incident ends. Do not automatically create permanent blocks from application errors, and do not
store a parallel blacklist or IP history inside SkillSpore.

Application logs and aggregate metrics should count upgrade rejections, rate-limited operations,
invalid messages, abuse-related socket closures, and TURN credential failures without recording
client IPs, nameplates, or message bodies. IP and ASN investigation belongs in Cloudflare Security
Events, which already sits at the enforcement layer.

## TURN design

Use Cloudflare Realtime TURN with distinct short-lived credentials for sender and receiver. Keep the
TURN key and API token in Cloudflare secrets and never send those long-lived secrets to clients.

Follow the
[Cloudflare credential-generation documentation](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

After the receiver upgrade succeeds and both roles are present, the session Durable Object should:

1. prepare Cloudflare STUN-only configuration when `TURN_MODE=stun-only`;
2. otherwise generate one 20-minute credential for each peer, using the same opaque session ID as
   the Cloudflare `customIdentifier` on both credentials;
3. persist only the returned usernames, key ID, and expiration timestamps;
4. send each socket a v1 `paired` message containing its role-specific ICE configuration; and
5. revoke any partially-generated credential and send STUN-only configuration to both peers if
   credential generation fails.

Credential generation failure emits an aggregate provider-error metric. It does not fail the
rendezvous session unless the deployment is running the forced-relay test mode.

Production WebRTC must use `iceTransportPolicy: "all"` so direct candidates are attempted and
preferred by ICE. Add a supported deployment-test option that forces `"relay"`; production is not
validated until both direct and forced-relay transfers succeed between machines on different
networks.

Emit one `session_completed` Workers Log event containing only the opaque random session ID and
completion timestamp. For the same reporting window, obtain the distinct TURN `customIdentifier`
values with nonzero egress from Cloudflare TURN analytics and intersect them with the completed
session IDs. Calculate:

```text
TURN fallback rate = completed session IDs with TURN egress / completed session IDs
direct transfer rate = 1 - TURN fallback rate
```

Both peer credentials share one random session identifier, so a relayed session is counted once.
Use a reporting window within Workers Logs retention. Do not include nameplates, IP addresses,
credential secrets, or payload metadata in either data source, and do not add a separate telemetry
service. See
[Cloudflare TURN analytics](https://developers.cloudflare.com/realtime/turn/analytics/).

## Project structure

Keep the current Node rendezvous application during migration as the v1 compatibility reference.

```text
apps/
  rendezvous/                 # existing Node reference server
  rendezvous-worker/          # Cloudflare Worker and session Durable Object
packages/
  protocol/                   # shared v1 types and runtime validation
  transport/                  # client rendezvous and WebRTC transport
```

The Worker package should remain small:

```text
apps/rendezvous-worker/
  src/worker.ts
  src/session-object.ts
  src/abuse.ts
  src/turn.ts
  src/validation.ts
  wrangler.toml
  package.json
```

Move runtime validation into the existing platform-neutral protocol package so the Node server and
Worker use the same v1 schemas.

## Wrangler configuration outline

The final values must be checked against the current Wrangler schema during implementation.

```toml
name = "skillspore-rendezvous"
main = "src/worker.ts"
compatibility_date = "2026-08-09"

[[durable_objects.bindings]]
name = "SESSIONS"
class_name = "RendezvousSession"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RendezvousSession"]

[[ratelimits]]
name = "UPGRADE_IP_LIMITER"
namespace_id = "1001"

[ratelimits.simple]
limit = 120
period = 60

[[ratelimits]]
name = "CREATE_IP_LIMITER"
namespace_id = "1002"

[ratelimits.simple]
limit = 20
period = 60

[[ratelimits]]
name = "JOIN_IP_LIMITER"
namespace_id = "1003"

[ratelimits.simple]
limit = 60
period = 60

[vars]
WAITING_TTL_SECONDS = "600"
CONNECTED_TTL_SECONDS = "900"
MAX_FAILED_ATTEMPTS = "5"
MAX_NAMEPLATE_ATTEMPTS = "20"
MAX_INVALID_MESSAGES_PER_SOCKET = "5"
MAX_SIGNALING_MESSAGES_PER_SECOND = "20"
SIGNALING_MESSAGE_BURST = "50"
MAX_SIGNALING_MESSAGES_PER_SESSION = "200"
SESSIONS_MODE = "enabled"
TURN_MODE = "best-effort"
TURN_CREDENTIAL_TTL_SECONDS = "1200"
MONTHLY_COST_TARGET_USD = "2"
TURN_WARNING_GB = "700"
TURN_STOP_GB = "850"
```

The rate limits are launch defaults and must be tuned using distributed tests so shared NATs are not
treated as individual abusive clients.

Secrets must be configured through Wrangler or the Cloudflare dashboard and never committed:

```shell
pnpm exec wrangler secret put TURN_KEY_ID
pnpm exec wrangler secret put TURN_KEY_API_TOKEN
```

## Deployment and migration

These steps apply after `apps/rendezvous-worker` is implemented:

1. Finalize the v1 runtime schemas, upgrade-subprotocol routing, Node reference server, transport client,
   and protocol tests in one change.
2. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
3. Create a Cloudflare Realtime TURN key and configure the Worker secrets.
4. Deploy the Worker to a staging hostname.
5. Confirm automatic DDoS protection is enabled and configure the WAF/rate-limit rules scoped to the
   rendezvous endpoint.
6. Run v1 contract, direct-transfer, forced-TURN, abuse-control, client-backoff, temporary-block,
   hibernation, cleanup, and quota-failure tests.
7. Run the 2,000-WebSocket load test and pass the objectives below.
8. Attach `rendezvous.example.org` as the Worker custom domain and configure the route to fail
   closed at the Workers Free daily request limit.
9. Release a CLI build tested against both the updated Node and Worker implementations.
10. Change the public CLI default endpoint to the Worker.
11. Keep the Node deployment available for rollback during a defined migration window.
12. Remove the Node production deployment after the rollback window closes.

The production CLI configuration remains:

```shell
export SKILLSPORE_SERVER_URL=wss://rendezvous.example.org/v1/rendezvous
```

Staging and production may use separate Cloudflare accounts when free-quota isolation is necessary.
A full staging load test must not consume quotas required by production.

Record the Git commit, Wrangler version, Worker deployment version, Durable Object migration tag,
compatibility date, `SESSIONS_MODE`, `TURN_MODE`, and active thresholds for every production deploy.

During the cutover change, update `docs/protocol.md`, `docs/deployment.md`, the README, and CLI help.
Until then, those files may continue describing the current Node deployment while this decision
remains the future-state authority.

No skill contents or active rendezvous sessions require data migration.

## Load-test requirements

Production approval requires a staging test that reaches or exceeds:

- 2,000 simultaneous anonymous WebSockets;
- 1,000 simultaneous session Durable Objects;
- 100 successful session creations per second for ten seconds;
- sender and receiver upgrade-subprotocol routing before WebSocket acceptance;
- rejection of missing, malformed, multiple, or contradictory role/nameplate subprotocol values;
- rejection of obsolete WebSocket `create` and `join` messages by the final v1 schema;
- at least 40 incoming signaling messages per session;
- 1,000 orderly session completions;
- abrupt sender and receiver disconnects;
- Durable Object hibernation and wake-up;
- expiration alarms at scale;
- incorrect passcodes and failed-attempt enforcement;
- Worker Rate Limiting rejection at scaled thresholds;
- a mixed-load abuse test with invalid or over-limit traffic at twice the normal request rate while
  legitimate clients continue operating;
- signaling floods against individual sessions without cross-session impact;
- CLI retry behavior for HTTP `429`, WebSocket `rate-limited`, and close code `1013` responses;
- a temporary WAF or IP Access block-and-remove drill; and
- at least 50 concurrent forced-TURN transfers of 25 MiB between machines on different networks.

Use scaled application thresholds for failure-path tests instead of intentionally exhausting the
staging account's real daily quotas.

Measure:

- WebSocket connection success rate;
- create and join latency percentiles;
- signaling relay latency percentiles;
- Worker and Durable Object errors;
- upgrade, create, join, and signaling rejection counts;
- the percentage of rejected upgrades stopped before Durable Object allocation;
- CPU time per Worker and WebSocket message;
- request and SQLite quota consumption;
- direct, server-reflexive, and relay candidate-pair outcomes;
- TURN credential generation and revocation outcomes;
- TURN egress; and
- cleanup correctness.

### Service objectives

Under the controlled staging test:

- at least 99.5% of attempted WebSocket connections succeed;
- at least 99.5% of valid create and join operations succeed before provider quotas are reached;
- create and join latency is at most 500 milliseconds at p95 and 1.5 seconds at p99;
- one-way signaling relay latency is at most 250 milliseconds at p95 and one second at p99 within
  the test topology;
- unexpected Worker errors, Durable Object overload errors, and unexplained socket closures remain
  below 0.1% of operations;
- at least 99% of valid operations from non-blocked clients succeed during the mixed-load abuse test;
- every client exceeding a socket or session message limit is closed without changing unrelated
  session success or latency objectives;
- rate-limited CLI clients attempt no more than three retries and use non-synchronized jittered
  delays;
- a temporary provider-managed block prevents the selected source from upgrading, and removing the
  block restores access without an application deployment;
- no rejected anonymous request is placed into an application-managed queue or persistent blacklist;
- every normal-path session writes at most six SQLite rows;
- 100% of orderly completion, cancellation, and expiration cases remove session storage within two
  minutes;
- every orderly session with TURN credentials attempts revocation for its persisted usernames;
- at least 80% of normal multi-network transfers use a non-relay candidate pair;
- 100% of verified skill payload bytes bypass the Worker and Durable Object; and
- at least 98% of the 50 concurrent forced-TURN transfers complete and pass hash verification.

Production telemetry may replace planning assumptions only after representative usage is available.
Changing the architecture requires evidence, not speculative future scale.

## Production acceptance gates

- Public access works without an organization account, OIDC identity, or service access token.
- Skill payload bytes never enter the Worker or Durable Object under direct or TURN operation.
- The normal multi-network test meets the 80% direct-transfer objective.
- The Node and Worker implementations pass the same final-v1 upgrade and message contract suite.
- Every accepted WebSocket is routed directly to its owning session Durable Object during the
  upgrade; no Worker or lobby WebSocket proxy remains in the connection path.
- Runtime schemas reject malformed or binary rendezvous messages without affecting unrelated
  sessions.
- Cloudflare DDoS protection, endpoint-scoped WAF/rate-limit rules, Worker throttles, and per-session
  message limits are enabled and pass the abuse tests.
- Rate-limited clients fail fast with bounded jittered retries; the service has no anonymous
  server-side queue.
- The temporary IP/ASN block and unblock runbook is tested without creating an application blacklist
  database.
- The 2,000-user load test passes every service objective above.
- Direct and forced-TURN transfers pass between multiple real networks.
- Worker, Durable Object request, and SQLite quotas have measured headroom for the initial workload.
- Workers and Durable Objects fail closed at provider limits.
- The under-$2 target, alerts, manual TURN cutoff, and STUN-only procedure are documented and tested.
- TURN credential secrets are never persisted; usernames required for revocation survive hibernation
  until cleanup.
- Unpaired sessions receive no TURN credentials, and the documented aggregate formula produces the
  direct-versus-relay rate without logging identities or payload data.
- Logs exclude client IPs, nameplates, passcodes, PAKE shares, SDP, ICE candidates, TURN credentials,
  skill metadata, and skill contents.
- Deployment and rollback procedures are tested.
- The protocol and cryptographic design receive an independent security review before sensitive or
  broad public use.

## Consequences

### Benefits

- Skill contents normally travel directly between peers.
- Neither the Worker nor Durable Object becomes a file-transfer bandwidth bottleneck.
- There is no VM or container fleet to operate.
- Session state naturally partitions across simple per-session Durable Objects.
- WebSocket hibernation matches short-lived, mostly idle rendezvous sessions.
- The existing protocol and four-digit passcodes remain compatible.
- The implementation avoids a global coordination subsystem and speculative scale infrastructure.
- Anyone can use the service without an organization-specific identity provider.

### Costs and risks

- The rendezvous server must be rewritten.
- The project depends on Cloudflare Workers, Durable Objects, and Realtime TURN.
- Anonymous public access increases abuse, enumeration, and denial-of-service risk.
- Distributed low-rate abuse may evade local per-IP counters, so the service still depends on
  Cloudflare's network and WAF protections.
- Temporary IP or ASN blocks can affect legitimate users on shared networks and require explicit
  expiry and review.
- Four-digit nameplates constrain the supported concurrency target.
- The final v1 upgrade contract differs from the current prototype and requires coordinated changes
  to the Node server, Worker, transport client, schemas, tests, and documentation before staging.
- Local rate limits do not provide an exact global concurrency or billing cap.
- TURN cutoff is operational and manual rather than real-time and automatic.
- Some restrictive networks require TURN, so not every transfer can be direct.
- Free limits and pricing can change.
- The provider bill can exceed the $2 target because it is not a hard cap.

## Review triggers

Revisit this decision when:

- legitimate concurrency regularly approaches 1,000 sessions;
- the four-digit namespace regularly exceeds 20% occupancy;
- the measured TURN fallback rate regularly exceeds 30%;
- monthly TURN usage approaches 700 GB;
- daily Worker, Durable Object request, or SQLite quotas regularly approach warning thresholds;
- manual `SESSIONS_MODE` or `TURN_MODE` controls are too slow for observed incidents;
- abusive traffic regularly reaches Worker or Durable Object quotas despite Cloudflare protection;
- rate-limited clients create retry storms or the three-retry policy harms legitimate recovery;
- temporary IP/ASN blocks become frequent enough to require automation or dedicated operations;
- abuse controls regularly throttle legitimate users or fail to contain misuse;
- monthly provider spend reaches or is forecast to exceed $2;
- availability requirements require an SLA;
- Cloudflare changes free-tier availability or pricing;
- regulatory or data-residency requirements cannot be met; or
- load testing disproves the 1,000-session capacity assumptions.

Only after one of these triggers is demonstrated should the project consider a longer nameplate,
rendezvous v2, global admission state, automated TURN accounting, or quota sharding.

# Hosting vendor switch: Railway to Oracle Cloud

- Status: Superseded by `docs/cloudflare-production-decision.md` after the requirements were
  clarified as approximately 10,000 concurrent users with a strong preference for $0 hosting.
- Date: 2026-08-08
- Scope: The public SkillSpore rendezvous service used by all organizational senders and receivers.

## Decision

SkillSpore will not use Railway as its default hosting platform. The rendezvous service will be
deployed on Oracle Cloud Infrastructure (OCI), initially on an Always Free-eligible compute
instance when capacity is available.

This is a centralized organizational service. Individual Macs and other client computers are only
senders or receivers; they do not host production infrastructure.

The first deployment remains a single rendezvous instance because the current implementation keeps
live WebSocket sessions in process memory. A single instance can serve multiple concurrent sender
and receiver pairs, but it is a single point of failure. It is suitable for an organizational pilot,
not for a high-availability production claim.

Organization-wide production requires the distributed session-routing, authentication,
observability, and abuse-control work listed in [Production rollout gates](#production-rollout-gates).

Cloudflare is not part of this decision. It is not required to deploy or operate SkillSpore.

## Why Oracle Cloud

OCI was selected because it:

- can run the existing Node.js Docker image and long-lived WebSocket server without a platform
  rewrite;
- provides Always Free-eligible compute for a low-cost pilot;
- allows direct control of the reverse proxy, firewall, deployment lifecycle, and monitoring;
- provides a path from one VM to paid compute, load balancing, and multiple fault domains if the
  organization outgrows the free resources; and
- can later host `coturn` if the organization chooses to operate TURN instead of buying a managed
  service.

OCI Always Free is a cost optimization, not an availability guarantee. Instance capacity can be
unavailable, and a free instance must not be treated as sufficient evidence of production
resilience. See the [OCI Free Tier documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)
and [Always Free resource documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Why Railway was rejected

Railway can run the current Docker/WebSocket application with little operational work, but that is
a convenience advantage rather than a technical requirement. It introduces recurring platform
cost and was previously selected without documenting cost, alternatives, or the organization's
priorities. That is not an adequate vendor decision.

The existing `railway.toml` may remain temporarily for compatibility, but Railway is no longer the
recommended production target. It can be removed after the OCI deployment and rollback plan have
been validated.

## Why Cloudflare was not selected

Cloudflare Tunnel would keep an origin machine in the production path, which is inappropriate for
an organization-wide service. Cloudflare Workers with Durable Objects could host a scalable
WebSocket coordinator, but doing so would require rewriting the current Node.js `ws` server around
Cloudflare runtime APIs. That rewrite is not required to meet the current hosting goal.

## Target architecture

During the pilot:

```text
many sender CLIs ───┐
                    ├── wss://rendezvous.example.org ── Caddy ── rendezvous container
many receiver CLIs ─┘                                      │
                                                           └── Twilio STUN/TURN tokens

skill payload: sender ═════════ direct WebRTC or TURN relay ═════════ receiver
```

The rendezvous service handles only:

- session creation and joining;
- PAKE share relay;
- WebRTC descriptions and ICE candidate relay; and
- short-lived ICE server configuration.

It does not receive the skill contents or the passcode secret.

For high availability:

```text
senders and receivers
        │
        ▼
OCI public load balancer
        │
        ├── rendezvous node A ──┐
        └── rendezvous node B ──┼── shared session state and cross-node relay
                                └── Redis-compatible store / pub-sub
```

Do not add a second rendezvous replica before cross-node session relay is implemented. The sender
WebSocket may terminate on one node and the receiver WebSocket on another; ordinary load-balancer
stickiness cannot route the receiver by a nameplate that is delivered inside the WebSocket
protocol.

## Pilot deployment instructions

### 1. Prepare OCI

1. Create an OCI account and select the home region carefully; Always Free compute is tied to the
   home region.
2. Create an Always Free-eligible Ampere A1 VM when capacity is available.
3. Use the current Ubuntu LTS image.
4. Reserve a public IP for the VM.
5. Add a DNS `A` record such as `rendezvous.example.org` pointing to that IP.
6. In the OCI network security list or network security group, allow:
   - TCP 22 only from administrator IP ranges;
   - TCP 80 from the internet; and
   - TCP 443 from the internet.
7. Do not expose the application port `8787` publicly.

### 2. Install Docker

Follow Docker's maintained
[Ubuntu installation instructions](https://docs.docker.com/engine/install/ubuntu/). The supported
repository installation is preferred over the convenience script.

At minimum, verify the result:

```shell
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

### 3. Install Caddy

Install Caddy from its official Ubuntu package repository using the
[Caddy installation instructions](https://caddyserver.com/docs/install). The package installs Caddy
as a systemd service.

Caddy is used for automatic TLS termination and WebSocket reverse proxying. Caddy supports
WebSocket upgrades through `reverse_proxy`; see the
[Caddy reverse-proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

### 4. Clone and build SkillSpore

```shell
sudo install -d -o "$USER" -g "$USER" /opt/skillspore
git clone https://github.com/Zhenghangxu/skill-secret-share.git /opt/skillspore/repo
cd /opt/skillspore/repo
git switch main
git pull --ff-only origin main
git rev-parse --short HEAD

IMAGE_TAG="$(git rev-parse --short HEAD)"
sudo docker build --pull \
  --file apps/rendezvous/Dockerfile \
  --tag "skillspore-rendezvous:${IMAGE_TAG}" \
  .
```

Deploy only reviewed commits from `main`. Record the image tag with every deployment.

### 5. Configure secrets

Create a root-readable environment file:

```shell
sudo install -d -m 0700 /etc/skillspore
sudoedit /etc/skillspore/rendezvous.env
sudo chmod 0600 /etc/skillspore/rendezvous.env
```

Initial managed-TURN configuration:

```text
PORT=8787
TWILIO_ACCOUNT_SID=<dedicated Twilio account or subaccount SID>
TWILIO_AUTH_TOKEN=<secret>
```

Do not set `SKILLSPORE_ICE_SERVERS_JSON` in production. Static TURN credentials must not be shipped
to clients. The rendezvous server already requests short-lived credentials from Twilio.

Use a dedicated Twilio subaccount, configure spending alerts and quotas, and rotate the credential.
Twilio TURN is usage-based and is not made free by hosting the rendezvous service on OCI. See the
[Twilio Network Traversal Service API](https://www.twilio.com/docs/stun-turn/api) and
[TURN billing FAQ](https://www.twilio.com/docs/stun-turn/faq).

### 6. Start the rendezvous container

From the checked-out repository:

```shell
IMAGE_TAG="$(git rev-parse --short HEAD)"

sudo docker run --detach \
  --name skillspore-rendezvous \
  --restart unless-stopped \
  --env-file /etc/skillspore/rendezvous.env \
  --publish 127.0.0.1:8787:8787 \
  "skillspore-rendezvous:${IMAGE_TAG}"
```

Verify the private origin before configuring public traffic:

```shell
curl --fail http://127.0.0.1:8787/healthz
sudo docker logs --tail 100 skillspore-rendezvous
```

Expected health response:

```json
{ "ok": true }
```

### 7. Configure HTTPS and WSS

Edit `/etc/caddy/Caddyfile`:

```caddyfile
rendezvous.example.org {
    reverse_proxy 127.0.0.1:8787 {
        stream_close_delay 5m
    }
}
```

Validate and reload:

```shell
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Caddy will obtain and renew a public certificate when the DNS record resolves to the VM and ports
80 and 443 are reachable. Its automatic HTTPS behavior is documented in the
[Caddy reverse-proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy).

Verify the public endpoint:

```shell
curl --fail https://rendezvous.example.org/healthz
```

The CLI endpoint is:

```text
wss://rendezvous.example.org/v1/rendezvous
```

### 8. Configure organizational clients

Every sender and receiver uses the same public rendezvous endpoint. No client machine hosts the
service.

On managed client machines:

```shell
export SKILLSPORE_SERVER_URL=wss://rendezvous.example.org/v1/rendezvous
```

Sender example:

```shell
skillspore share /absolute/path/to/skill
```

Receiver example:

```shell
skillspore fetch --download-only --output /absolute/path/to/received-skill
```

Distribute the endpoint through the organization's standard shell, device-management, or CLI
configuration mechanism. Do not distribute Twilio credentials to clients.

## Deployment updates and rollback

The current server stores sessions in memory. Restarting it terminates active transfers. Until a
drain mode exists, announce a maintenance window and verify that `/metrics` reports no active
sessions before replacing the container.

Build a new immutable image:

```shell
cd /opt/skillspore/repo
git fetch origin main
git switch main
git pull --ff-only origin main
IMAGE_TAG="$(git rev-parse --short HEAD)"
sudo docker build --pull -f apps/rendezvous/Dockerfile \
  -t "skillspore-rendezvous:${IMAGE_TAG}" .
```

Check active sessions:

```shell
curl --fail http://127.0.0.1:8787/metrics
```

When `activeSessions` is zero:

```shell
sudo docker stop skillspore-rendezvous
sudo docker rm skillspore-rendezvous
sudo docker run --detach \
  --name skillspore-rendezvous \
  --restart unless-stopped \
  --env-file /etc/skillspore/rendezvous.env \
  --publish 127.0.0.1:8787:8787 \
  "skillspore-rendezvous:${IMAGE_TAG}"
```

For rollback, repeat the final commands with the previously recorded image tag. Do not delete the
previous image until the new deployment passes health and end-to-end tests.

## Production rollout gates

The pilot must not be described as high-availability or organization-ready until these gates are
complete.

### Required security controls

- Add organizational authentication before `create` and `join`. Anonymous internet clients must
  not be able to mint paid TURN credentials.
- Add a CLI authentication mechanism suitable for managed devices, such as short-lived signed
  tokens obtained through organizational identity.
- Move rate limiting and abuse counters out of process memory.
- Validate every untrusted rendezvous and signaling message against a runtime schema before use.
- Restrict `/metrics` to internal monitoring or require authentication.
- Complete an independent review of the PAKE, WebRTC binding, secret scanning, and installer
  transaction boundaries before transferring sensitive organizational material.

### Required availability work

- Move session metadata to a shared Redis-compatible store.
- Implement cross-node relay so sender and receiver WebSockets can terminate on different nodes.
- Run at least two rendezvous nodes in separate OCI fault domains.
- Place an OCI load balancer in front of the nodes only after cross-node relay works.
- Add connection draining so deployments stop accepting new sessions while existing sessions
  finish.
- Define recovery-time and availability objectives and use paid OCI resources if the free tier
  cannot meet them.

### Required TURN work

- Test both direct and forced-relay transfers across multiple real networks.
- Add a supported way to force `iceTransportPolicy: "relay"` during deployment verification.
- Monitor TURN allocation failures, relayed bandwidth, and spending.
- If replacing Twilio with `coturn`, deploy TURN separately from rendezvous, use short-lived REST
  credentials, support UDP and TCP/TLS fallback, and operate more than one relay location for
  organizational production.

### Required operations work

- Add an external uptime check for `/healthz`.
- Export aggregate session, rejection, failure, and completion metrics without logging passcodes,
  SDP, ICE candidates, TURN credentials, or skill metadata.
- Alert on health failures, elevated rejection rates, TURN-provider errors, and resource pressure.
- Add container-image scanning and a deployed WebSocket smoke test to CI.
- Document credential rotation, incident response, deployment, rollback, and compromised-host
  procedures.
- Patch the VM, Docker Engine, Caddy, Node base image, and dependencies on a defined schedule.

## Acceptance tests

Before the pilot is opened to the organization:

1. Verify HTTPS health from outside OCI.
2. Verify two clients on different networks can create and join a session.
3. Verify the output reports `direct` when direct ICE succeeds.
4. Verify a forced TURN test reports `relay`.
5. Verify an incorrect passcode does not invalidate the sender before the failed-attempt limit.
6. Verify waiting sessions remain available for the documented 10-minute TTL.
7. Verify completed, expired, and disconnected sessions are removed.
8. Verify no skill bytes, passcodes, SDP, ICE candidates, or TURN credentials appear in logs.
9. Verify rollback to the previous container image.
10. Run a concurrency test sized to the expected organizational peak plus safety margin.

## Decision review triggers

Revisit this vendor decision when any of the following occurs:

- Always Free capacity or reliability prevents meeting the pilot objectives.
- Organizational policy requires a formal SLA, managed support, or a specific cloud vendor.
- Concurrent session volume exceeds a single VM's tested safe capacity.
- Multi-region latency or availability becomes a requirement.
- The operational cost of self-managing OCI exceeds the cost of a managed platform.
- A Cloudflare Durable Objects rewrite or another managed coordinator becomes cheaper than
  maintaining the Node.js service.

# Rendezvous deployment

The beta deployment uses one Railway service for rendezvous and Twilio Network Traversal Service for
short-lived STUN/TURN credentials.

## Railway

Deploy the repository using `apps/rendezvous/Dockerfile` and configure `/healthz` as the health
check. The service must remain a singleton because live sessions are stored only in memory.

Required variables:

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
```

Railway supplies `PORT`. Point the CLI at the resulting endpoint:

```shell
export SKILLSPORE_SERVER_URL=wss://<domain>/v1/rendezvous
```

For local or isolated testing, `SKILLSPORE_ICE_SERVERS_JSON` can provide a JSON ICE server array.
Do not use static TURN credentials for a public deployment.

## Operational controls

- Configure Twilio spending alerts and account-level quotas.
- Keep TURN credentials at the implemented 15-minute TTL.
- Do not log request bodies, SDP, ICE candidates, nameplates, or TURN credentials.
- Monitor aggregate active sessions, failures, process health, and provider errors only.
- Redeploying terminates active sessions; no skill data needs migration or persistent storage.
- Add Redis and coordinated session routing before increasing the rendezvous service above one
  instance.

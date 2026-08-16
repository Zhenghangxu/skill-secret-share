# Relay deployment

SkillSpore no longer has a server component. By default it uses croc's standard connectivity and
public relay behavior.

To operate a private relay, install the same supported croc release on a server and run:

```shell
croc relay
```

croc uses ports 9009-9013 by default. Configure the firewall and TLS/network controls according to
the [croc self-hosting documentation](https://github.com/schollz/croc#self-host-relay).

Point both SkillSpore peers at it with either:

```shell
skillspore share ./example-skill --relay relay.example.com:9009
skillspore fetch --relay relay.example.com:9009
```

or:

```shell
export SKILLSPORE_CROC_RELAY=relay.example.com:9009
```

The relay is not trusted with plaintext, but it can observe connection metadata, deny service, and
attempt traffic analysis. Keep croc patched, restrict administrative access, and monitor resource
use. Relay passwords and advanced croc flags are intentionally outside SkillSpore's wrapper; use a
dedicated croc configuration or extend the narrow adapter deliberately if those become requirements.

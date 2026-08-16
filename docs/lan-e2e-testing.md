# End-to-end testing

Install croc 10.7.0 or newer and the same SkillSpore build on both computers.

For a normal test, run on the sender:

```shell
skillspore share ./apps/cli/lan-e2e-skill
```

Then run `skillspore fetch` on the receiver and enter the displayed passcode. Confirm that croc's
incoming size is reasonable, then complete a download-only test before testing installation:

```shell
skillspore fetch --download-only --output ./received-skill
```

Compare `received-skill` with the source and confirm that SkillSpore printed a validated manifest.

## Private LAN relay

To avoid the public relay during a controlled test, start a croc relay on one computer:

```shell
croc relay
```

Assuming that computer is `192.168.1.50`, pass the same relay to both commands:

```shell
skillspore share ./apps/cli/lan-e2e-skill --relay 192.168.1.50:9009
skillspore fetch --relay 192.168.1.50:9009 --download-only --output ./received-skill
```

Allow the relay's configured ports through the host firewall for the duration of the test. Stop the
relay with `Ctrl+C` afterward.

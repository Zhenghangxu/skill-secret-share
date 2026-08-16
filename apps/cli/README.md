# SkillSpore CLI

Experimental end-to-end encrypted Agent Skill transfer and transactional installation for Codex,
Claude Code, and Cursor. croc owns the encrypted network transfer; SkillSpore validates, reviews,
and installs the received skill.

Requires [croc](https://github.com/schollz/croc) 10.7.0 or newer on `PATH`.

```shell
npx skillspore share ./example-skill
npx skillspore fetch
```

Passcodes are entered through hidden prompts and are never accepted as process arguments. See the
main SkillSpore repository for the threat model and relay documentation.

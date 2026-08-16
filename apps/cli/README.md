# SkillSpore CLI

Experimental peer-to-peer Agent Skill transfer and transactional installation for Codex, Claude
Code, and Cursor.

Requires [croc](https://github.com/schollz/croc) 10.7.0 or newer on `PATH`.

```shell
npx skillspore share ./example-skill
npx skillspore fetch
```

Passcodes are entered through hidden prompts and are never accepted as process arguments. See the
main SkillSpore repository for the threat model and relay documentation.

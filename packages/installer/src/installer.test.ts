import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createManifest, encodeFileFrame } from '@skillspore/protocol';
import { AGENTS } from './agents.js';
import { diffSkillDirectories } from './diff.js';
import { QuarantineWriter } from './quarantine.js';
import { prepareSkill, validateIncomingManifest, validateSkill } from './skill.js';
import { installSkillTransaction } from './transaction.js';
import { agents as upstreamAgents } from './upstream/agents.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'skillspore-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createSkill(
  parent: string,
  name = 'example-skill',
  body = 'hello\n'
): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Example test skill\nallowed-tools: Read\n---\n\n# Example\n`
  );
  await writeFile(join(root, 'content.txt'), body);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('upstream agent registry adapter', () => {
  it('uses the pinned upstream paths for every supported agent', () => {
    for (const id of ['codex', 'claude-code', 'cursor'] as const) {
      expect(AGENTS[id].projectSkillsDir).toBe(upstreamAgents[id].skillsDir);
      expect(AGENTS[id].globalSkillsDir()).toBe(upstreamAgents[id].globalSkillsDir);
    }
  });
});

describe('skill validation and preparation', () => {
  it('validates a specification-compliant skill and prepares a hashed manifest', async () => {
    const parent = await temporaryDirectory();
    const root = await createSkill(parent);
    const metadata = await validateSkill(root);
    expect(metadata.name).toBe('example-skill');
    const prepared = await prepareSkill(root);
    expect(prepared.manifest.files.map((file) => file.path)).toEqual(['content.txt', 'SKILL.md']);
    expect(prepared.manifest.totalBytes).toBeGreaterThan(0);
  });

  it('rejects a mismatched directory name and symlinks', async () => {
    const parent = await temporaryDirectory();
    const root = await createSkill(parent, 'wrong-directory');
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: different-name\ndescription: mismatch\n---\n'
    );
    await expect(validateSkill(root)).rejects.toThrow(/match its directory name/);

    const valid = await createSkill(parent, 'valid-skill');
    await symlink(join(valid, 'content.txt'), join(valid, 'linked.txt'));
    await expect(prepareSkill(valid)).rejects.toThrow(/Symlinks are not allowed/);
  });

  it('rejects authenticated manifests with unsafe paths or no SKILL.md', () => {
    const unsafe = createManifest({
      skill: { name: 'example-skill', description: 'Example' },
      files: [
        {
          path: '../SKILL.md',
          size: 0,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          executable: false,
        },
      ],
    });
    expect(() => validateIncomingManifest(unsafe)).toThrow(/unsafe or duplicate path/);

    const missingSkill = createManifest({
      skill: { name: 'example-skill', description: 'Example' },
      files: [
        {
          path: 'content.txt',
          size: 0,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          executable: false,
        },
      ],
    });
    expect(() => validateIncomingManifest(missingSkill)).toThrow(/include SKILL.md/);
  });
});

describe('quarantine verification', () => {
  it('receives frames and verifies every file hash', async () => {
    const parent = await temporaryDirectory();
    const source = await createSkill(parent);
    const prepared = await prepareSkill(source);
    const quarantine = await QuarantineWriter.create(prepared.manifest);
    try {
      for (let index = 0; index < prepared.manifest.files.length; index++) {
        const file = prepared.manifest.files[index]!;
        const data = await readFile(join(source, ...file.path.split('/')));
        await quarantine.writeFrame(encodeFileFrame({ fileIndex: index, offset: 0, data }));
      }
      await quarantine.verify();
      expect(await readFile(join(quarantine.rootDir, 'content.txt'), 'utf8')).toBe('hello\n');
    } finally {
      await quarantine.cleanup();
    }
  });
});

describe('diff and transactional installation', () => {
  it('shows text changes and atomically installs symlinked agent targets', async () => {
    const parent = await temporaryDirectory();
    const cwd = join(parent, 'project');
    const oldSkill = await createSkill(join(parent, 'old'), 'example-skill', 'old\n');
    const newSkill = await createSkill(join(parent, 'new'), 'example-skill', 'new\n');
    const changes = await diffSkillDirectories(oldSkill, newSkill);
    expect(changes.find((change) => change.path === 'content.txt')?.patch).toContain('-old');

    const result = await installSkillTransaction({
      sourceDir: newSkill,
      skillName: 'example-skill',
      agents: ['codex', 'claude-code'],
      scope: 'project',
      mode: 'symlink',
      cwd,
    });
    expect(result.paths).toHaveLength(2);
    expect(await readFile(join(cwd, '.agents/skills/example-skill/content.txt'), 'utf8')).toBe(
      'new\n'
    );
    expect(await readFile(join(cwd, '.claude/skills/example-skill/content.txt'), 'utf8')).toBe(
      'new\n'
    );
  });

  it('restores all previous installations when a commit fails', async () => {
    const parent = await temporaryDirectory();
    const cwd = join(parent, 'project');
    const previous = await createSkill(join(cwd, '.agents/skills'), 'example-skill', 'previous\n');
    expect(previous).toContain('.agents/skills');
    const incoming = await createSkill(join(parent, 'incoming'), 'example-skill', 'incoming\n');
    await expect(
      installSkillTransaction({
        sourceDir: incoming,
        skillName: 'example-skill',
        agents: ['codex', 'claude-code'],
        scope: 'project',
        mode: 'symlink',
        cwd,
        testFaultAfterCommit: 1,
      })
    ).rejects.toThrow(/Injected transaction failure/);
    expect(await readFile(join(cwd, '.agents/skills/example-skill/content.txt'), 'utf8')).toBe(
      'previous\n'
    );
  });
});

import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ManifestFile, PackageManifest } from '../../../packages/protocol/src/index.js';
import type { SecretFinding, SkillDiffEntry } from '../../../packages/installer/src/index.js';

export function sanitizeTerminal(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\p{Cf}/gu, '');
}

export function assertNotCancelled<T>(value: T | symbol, message = 'Cancelled'): T {
  if (p.isCancel(value)) {
    p.cancel(message);
    throw new Error(message);
  }
  return value as T;
}

export function printManifest(manifest: PackageManifest): void {
  const executables = manifest.files.filter((file) => file.executable);
  p.note(
    [
      `${pc.bold(sanitizeTerminal(manifest.skill.name))}`,
      sanitizeTerminal(manifest.skill.description),
      `Files: ${manifest.files.length}`,
      `Size: ${formatBytes(manifest.totalBytes)}`,
      manifest.skill.compatibility
        ? `Compatibility: ${sanitizeTerminal(manifest.skill.compatibility)}`
        : undefined,
      manifest.skill.allowedTools
        ? `Allowed tools: ${sanitizeTerminal(manifest.skill.allowedTools)}`
        : undefined,
      executables.length > 0
        ? `Executable files: ${executables.map((file) => sanitizeTerminal(file.path)).join(', ')}`
        : undefined,
      '',
      ...formatFileList(manifest.files),
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
    'Skill review'
  );
}

function formatFileList(files: ManifestFile[]): string[] {
  const shown = files
    .slice(0, 20)
    .map((file) => `  ${file.executable ? '*' : ' '} ${sanitizeTerminal(file.path)}`);
  if (files.length > shown.length) shown.push(`  … ${files.length - shown.length} more`);
  return shown;
}

export function printSecretFindings(findings: SecretFinding[]): void {
  if (findings.length === 0) return;
  p.note(
    findings
      .map(
        (finding) =>
          `${pc.yellow(sanitizeTerminal(finding.path))}\n${sanitizeTerminal(finding.message)}`
      )
      .join('\n\n'),
    'Possible secrets detected'
  );
}

export function printDiff(changes: SkillDiffEntry[]): void {
  if (changes.length === 0) {
    p.log.info('The installed skill already matches the received files.');
    return;
  }
  const summary = changes
    .map((change) => `${change.kind.padEnd(8)} ${sanitizeTerminal(change.path)}`)
    .join('\n');
  p.note(summary, 'Existing installation changes');
  for (const change of changes.filter((entry) => entry.patch)) {
    console.log(sanitizeTerminal(change.patch!));
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

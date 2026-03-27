import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runTokenlessFlow, runTokenlessMultiTurnFlow } from '../../src/smoke/tokenless-harness.js';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../..');

describe('runTokenlessFlow', () => {
  it('simulates create -> turn -> permission -> approve -> complete without a Discord token', async () => {
    const result = await runTokenlessFlow();

    expect(result.finalState).toBe('idle');
    expect(result.rendered.latestText).toContain('Preparing workspace');
    expect(result.rendered.latestText).toContain('Finished successfully');
    expect(result.rendered.latestText).not.toContain('Approval needed');
    expect(result.auditActions).toEqual([
      'discord.session.create',
      'discord.prompt.resolve'
    ]);
  });

  it('runs the tokenless harness from the package script against source files', async () => {
    const { stdout } = await execFileAsync('npm', ['run', 'smoke:tokenless'], {
      cwd: repoRoot
    });

    expect(stdout).toContain('"finalState": "idle"');
    expect(stdout).toContain('"discord.session.create"');
  });

  it('preserves session context across multiple turns in the same session', async () => {
    const result = await runTokenlessMultiTurnFlow();

    expect(result.finalState).toBe('idle');
    expect(result.replies).toEqual([
      'I will remember alpha.',
      'You asked me to remember alpha.'
    ]);
  });
});

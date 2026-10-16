import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('packaged Action rejects missing command from a clean consumer directory without dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evals-packaged-'));
  try {
    const entry = join(root, 'index.cjs');
    await copyFile(resolve('dist/index.cjs'), entry);
    const summary = join(root, 'summary.md');
    const output = join(root, 'output.txt');
    await Promise.all([writeFile(summary, ''), writeFile(output, ''), mkdir(join(root, 'runner'))]);
    const child = spawnSync(process.execPath, [entry], {
      cwd: root,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, RUNNER_TEMP: join(root, 'runner'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stdout, /invalid-input-or-context/);
    assert.match(await readFile(summary, 'utf8'), /Evals: error/);
    assert.match(await readFile(output, 'utf8'), /outcome/);
    // Artifact service credentials are intentionally absent; this is a fail-closed packaging control.
    assert.match(child.stdout, /Required structured reporting failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

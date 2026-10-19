import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { assertSerializedReporter } from '../src/reporter.js';

const execute = promisify(execFile);

describe('real Copilot example contract', () => {
  it('is native-lint clean without evaluator credentials', async () => {
    const manifest = createRequire(import.meta.url).resolve('@microsoft/vally-cli/package.json');
    const entry = join(dirname(manifest), 'dist', 'index.js');
    const result = await execute(process.execPath, [entry, 'lint', `--eval-spec=${resolve('examples/copilot-smoke')}`], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        VALLY_TELEMETRY_OPTOUT: '1', DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true',
      },
      timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    expect(result.stderr).not.toContain('COPILOT_GITHUB_TOKEN');
  }, 60_000);

  it('demonstrates one job, one checkout and one direct Action step using defaults', async () => {
    const source = await readFile('.github/workflows/copilot-e2e.yml', 'utf8');
    const workflow = parse(source) as {
      on: { pull_request: { paths: string[] }; workflow_dispatch: unknown };
      permissions: Record<string, string>;
      jobs: Record<string, {
        if: string; uses?: string; permissions: Record<string, string>;
        concurrency: { group: string; 'cancel-in-progress': boolean };
        steps: Array<{ uses?: string; with?: Record<string, unknown>; run?: string; 'continue-on-error'?: boolean }>;
      }>;
    };
    expect(Object.keys(workflow.jobs)).toEqual(['evals']);
    const job = workflow.jobs.evals!;
    expect(job).not.toHaveProperty('uses');
    expect(job.if).toContain('head.repo.full_name == github.repository');
    expect(workflow.on.pull_request.paths).toContain('examples/copilot-smoke/**');
    expect(job.permissions).toEqual({ contents: 'read', 'copilot-requests': 'write', 'pull-requests': 'write' });
    expect(job.steps).toHaveLength(2);
    expect(job.steps[0]).toEqual({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { 'persist-credentials': false },
    });
    expect(job.steps[1]).toEqual({
      uses: './', with: { 'working-directory': 'examples/copilot-smoke', suite: 'copilot-smoke' },
    });
    expect(job.steps.every((step) => step.run === undefined && !step['continue-on-error'])).toBe(true);
    await expect(readFile('.github/workflows/evals.yml')).rejects.toMatchObject({ code: 'ENOENT' });
    assertSerializedReporter(source, {
      repository: 'github/evals-action', workflowRef: 'github/evals-action/.github/workflows/copilot-e2e.yml@refs/pull/6/merge',
      workflowSha: 'b'.repeat(40), job: 'evals', reportId: 'evals', selection: 'c'.repeat(64),
      pullNumber: 6, runId: 1000, order: { runNumber: 10, attempt: 2 },
    });
  });

  it('loads one real skill and requires both invocation and exact output', async () => {
    const evalSpec = parse(await readFile('examples/copilot-smoke/copilot-smoke.eval.yaml', 'utf8')) as {
      defaults: Record<string, unknown>;
      agent_environment: { skills: string[] };
      stimuli: Array<{ graders: Array<{ type: string; config: Record<string, unknown> }> }>;
    };
    expect(evalSpec.defaults).toMatchObject({ executor: 'copilot-sdk', runs: 1, timeout: '60s' });
    expect(evalSpec.agent_environment.skills).toEqual(['./skills/evals-action-smoke']);
    expect(evalSpec.stimuli).toHaveLength(1);
    expect(evalSpec.stimuli[0]!.graders.map((grader) => grader.type)).toEqual(['skill-invocation', 'output-matches']);
    const pattern = String(evalSpec.stimuli[0]!.graders[1]!.config.pattern);
    expect(pattern).toBe('^EVALS_ACTION_SKILL_OK$(?![\\s\\S])');
    const exact = new RegExp(pattern);
    expect(exact.test('EVALS_ACTION_SKILL_OK')).toBe(true);
    for (const value of [' EVALS_ACTION_SKILL_OK', 'EVALS_ACTION_SKILL_OK ', 'EVALS_ACTION_SKILL_OK\n']) {
      expect(exact.test(value)).toBe(false);
    }
    const skill = await readFile('examples/copilot-smoke/skills/evals-action-smoke/SKILL.md', 'utf8');
    expect(skill).toContain('name: evals-action-smoke');
    expect(skill).toContain('`EVALS_ACTION_SKILL_OK`');
  });
});

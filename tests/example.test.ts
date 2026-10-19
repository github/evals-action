import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const execute = promisify(execFile);

describe('real Copilot example contract', () => {
  it('is native-lint clean without evaluator credentials', async () => {
    const manifest = createRequire(import.meta.url).resolve('@microsoft/vally-cli/package.json');
    const entry = join(dirname(manifest), 'dist', 'index.js');
    const result = await execute(process.execPath, [entry, 'lint', `--eval-spec=${resolve('examples/copilot-smoke')}`], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        VALLY_TELEMETRY_OPTOUT: '1',
        DO_NOT_TRACK: '1',
        OTEL_SDK_DISABLED: 'true',
      },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.stderr).not.toContain('COPILOT_GITHUB_TOKEN');
  }, 60_000);

  it('exposes the reusable workflow as a minimal bounded caller', async () => {
    const caller = parse(await readFile('.github/workflows/copilot-e2e.yml', 'utf8')) as {
      on: { pull_request: { paths: string[] }; workflow_dispatch: unknown };
      permissions: Record<string, string>;
      concurrency: { group: string; 'cancel-in-progress': boolean };
      jobs: Record<string, {
        permissions?: Record<string, string>;
        uses: string;
        with: Record<string, unknown>;
      }>;
    };
    expect(caller.on.pull_request.paths).toContain('examples/copilot-smoke/**');
    expect(caller.on.pull_request.paths).toContain('.github/workflows/evals.yml');
    expect(caller.permissions).toEqual({ contents: 'read' });
    expect(caller.concurrency['cancel-in-progress']).toBe(true);
    expect(Object.keys(caller.jobs)).toEqual(['evals']);
    const call = caller.jobs.evals!;
    expect(call.uses).toBe('./.github/workflows/evals.yml');
    expect(call.with).toMatchObject({
      'working-directory': 'examples/copilot-smoke',
      suite: 'copilot-smoke',
      'max-retries': '0',
    });
    expect(call.with).not.toHaveProperty('command');
    expect(call.with).not.toHaveProperty('copilot-token');
    expect(call.permissions).toEqual({
      contents: 'read', 'copilot-requests': 'write', 'pull-requests': 'write',
    });
  });

  it('keeps reusable modes permission-isolated and artifact reporting checkout-free', async () => {
    const workflow = parse(await readFile('.github/workflows/evals.yml', 'utf8')) as {
      on: { workflow_call: { inputs: Record<string, { default?: unknown; required?: boolean }> } };
      jobs: Record<string, {
        if?: string;
        permissions?: Record<string, string>;
        concurrency?: { group: string; 'cancel-in-progress': boolean };
        steps: Array<Record<string, unknown>>;
      }>;
    };
    expect(workflow.on.workflow_call.inputs.command?.default).toBe('all');
    expect(workflow.on.workflow_call.inputs['working-directory']?.required).toBe(true);
    expect(workflow.jobs.validate!.permissions).toEqual({});
    const lint = workflow.jobs.lint!;
    const run = workflow.jobs.run!;
    const all = workflow.jobs.all!;
    expect(lint.permissions).toEqual({ contents: 'read' });
    expect(run.permissions).toEqual({ contents: 'read', 'copilot-requests': 'write' });
    expect(all.permissions).toEqual({ contents: 'read', 'copilot-requests': 'write' });
    for (const job of [lint, run, all]) {
      expect(job.if).toContain("github.event_name != 'pull_request_target'");
      expect(job.if).toContain('head.repo.full_name == github.repository');
    }
    expect([lint, run, all].map((job) =>
      job.steps.filter((step) => step.uses === 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1').length))
      .toEqual([1, 1, 1]);
    expect(all.steps.find((step) => step.id === 'evals')?.if).toBe("${{ steps.lint.outcome == 'success' }}");
    expect(all.steps.some((step) => step['continue-on-error'] === true)).toBe(false);
    const report = workflow.jobs.report!;
    expect(report.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    expect(report.concurrency).toEqual({ group: 'evals-${{ github.workflow_ref }}', 'cancel-in-progress': false });
    expect(report.steps.some((step) => String(step.uses).startsWith('actions/checkout@'))).toBe(false);
    expect(report.steps).toHaveLength(2);
    expect(String(report.if)).toContain('always()');
    for (const step of report.steps) {
      expect(step.with).toMatchObject({ command: 'report', 'report-token': '${{ github.token }}' });
      expect(step.env).toMatchObject({
        EVALS_JOB_WORKFLOW_REF: '${{ job.workflow_ref }}',
        EVALS_JOB_WORKFLOW_SHA: '${{ job.workflow_sha }}',
        EVALS_JOB_WORKFLOW_REPOSITORY: '${{ job.workflow_repository }}',
        EVALS_JOB_WORKFLOW_FILE_PATH: '${{ job.workflow_file_path }}',
      });
      expect(step.with).not.toHaveProperty('copilot-token');
      expect(String(step.uses)).toMatch(/^github\/evals-action@[a-f0-9]{40}$/);
    }
    expect(workflow.jobs).not.toHaveProperty('verdict');
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
    expect(exact.test(' EVALS_ACTION_SKILL_OK')).toBe(false);
    expect(exact.test('EVALS_ACTION_SKILL_OK ')).toBe(false);
    expect(exact.test('EVALS_ACTION_SKILL_OK\n')).toBe(false);
    const skill = await readFile('examples/copilot-smoke/skills/evals-action-smoke/SKILL.md', 'utf8');
    expect(skill).toContain('name: evals-action-smoke');
    expect(skill).toContain('`EVALS_ACTION_SKILL_OK`');
  });
});

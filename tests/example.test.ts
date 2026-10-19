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

  it('keeps the automatic workflow bounded and least privilege', async () => {
    const workflow = parse(await readFile('.github/workflows/copilot-e2e.yml', 'utf8')) as {
      on: { pull_request: { paths: string[] }; workflow_dispatch: unknown };
      permissions: Record<string, string>;
      concurrency: { group: string; 'cancel-in-progress': boolean };
      jobs: Record<string, { if: string; permissions?: Record<string, string>; steps: Array<Record<string, unknown>> }>;
    };
    expect(workflow.on.pull_request.paths).toContain('examples/copilot-smoke/**');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
    const run = workflow.jobs.run!;
    expect(run.if).toContain("head.repo.full_name == github.repository");
    expect(run.permissions).toEqual({ contents: 'read', 'copilot-requests': 'write' });
    const action = run.steps.find((step) => step.uses === './')!;
    expect(action.with).toMatchObject({
      command: 'run',
      'working-directory': 'examples/copilot-smoke',
      suite: 'copilot-smoke',
      'vally-version': '0.19.0',
      runs: 1,
      workers: 1,
      'max-retries': 0,
      timeout: 60,
      'credential-env': 'COPILOT_GITHUB_TOKEN',
    });
    expect(action.env).toEqual({ COPILOT_GITHUB_TOKEN: '${{ github.token }}' });
    expect(action.with).not.toHaveProperty('report-token');
    expect(action.with).not.toHaveProperty('upload-transcripts');
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

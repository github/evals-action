import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { assertSerializedReporter } from '../src/reporter.js';

const execute = promisify(execFile);

describe('telemetry workflow contracts', () => {
  it('opts out packaged acceptance fixtures without changing other workflow defaults', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8')) as {
      env?: Record<string, string>;
      jobs: Record<string, {
        env?: Record<string, string>;
        steps: Array<{ uses?: string; env?: Record<string, string>; with?: Record<string, string> }>;
      }>;
    };
    expect(workflow.env).toBeUndefined();
    expect(workflow.jobs.check?.env).toBeUndefined();
    const packaged = workflow.jobs.packaged!;
    expect(packaged.env).toEqual({ VALLY_TELEMETRY_OPTOUT: '1', DO_NOT_TRACK: '1' });
    const acceptanceSteps = packaged.steps.filter((step) => step.uses === './');
    expect(acceptanceSteps.map((step) => step.with?.command)).toEqual(['run', 'run', 'lint']);
    for (const step of acceptanceSteps) expect(step.env).toBeUndefined();
  });

  it('documents the native telemetry default and a concrete caller opt-out', async () => {
    const readme = await readFile('README.md', 'utf8');
    expect(readme).toContain('Vally collects pseudonymous usage telemetry by default');
    expect(readme).toContain('https://microsoft.github.io/vally/reference/telemetry/');
    const source = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]!)
      .find((yaml) => yaml.includes('VALLY_TELEMETRY_OPTOUT:'))!;
    const steps = parse(source) as Array<{ uses: string; env: Record<string, string>; with: Record<string, string> }>;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ uses: 'github/evals-action@v0', env: { VALLY_TELEMETRY_OPTOUT: '1' } });
    expect(steps[0]!.with).not.toHaveProperty('credential-env');
  });
});

describe('documentation content contracts', () => {
  it('states in Outcomes and evidence that passing checks do not guarantee AI correctness and omits the internal license-clearance note', async () => {
    const readme = await readFile('README.md', 'utf8');
    const outcomesMatch = /\n## Outcomes and evidence\n([\s\S]*?)(?=\n## |$)/.exec(readme);
    expect(outcomesMatch?.[1]).toContain("A passing check doesn't guarantee the AI will get it right every time.");
    expect(readme).not.toContain('Entries marked `missing-license-text` still need authoritative terms');
    expect(readme).not.toContain('release-owner clearance before public distribution');
  });
});

describe('real Copilot example contract', () => {
  it('documents separate jobs with one automatic reporter and no artifact wiring', async () => {
    const readme = await readFile('README.md', 'utf8');
    const source = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]!)
      .find((yaml) => yaml.includes('\n  lint:'))!;
    const workflow = parse(source) as {
      jobs: Record<string, {
        needs?: string | string[]; if?: string; outputs?: unknown;
        permissions: Record<string, string>; concurrency?: unknown;
        steps: Array<{ uses: string; id?: string; with: Record<string, unknown> }>;
      }>;
    };
    expect(Object.keys(workflow.jobs)).toEqual(['lint', 'run', 'report']);
    const { lint, run, report } = workflow.jobs;
    expect(run!.needs).toBe('lint');
    expect(report!.needs).toEqual(['lint', 'run']);
    expect(report!.if).toContain('always()');
    expect(report!.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(report!.if).toContain('head.repo.full_name == github.repository');
    expect(report!.permissions).toEqual({ actions: 'read', contents: 'read', 'pull-requests': 'write' });
    expect(report!.steps).toEqual([{ uses: 'github/evals-action@v0', with: { command: 'report' } }]);
    for (const job of [lint!, run!]) {
      expect(job.outputs).toBeUndefined();
      expect(job.concurrency).toBeUndefined();
      expect(job.permissions['pull-requests']).toBeUndefined();
      expect(job.steps.every((step) => step.id === undefined && step.with['report-id'] === undefined)).toBe(true);
    }
    assertSerializedReporter(source, {
      repository: 'o/r', workflowRef: 'o/r/.github/workflows/evals-ci.yml@refs/pull/3/merge',
      workflowSha: 'b'.repeat(40), job: 'report', reportId: 'evals', selection: 'c'.repeat(64),
      pullNumber: 3, runId: 1000, order: { runNumber: 10, attempt: 2 },
    });
  });

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
      uses: 'actions/checkout@v7', with: { 'persist-credentials': false },
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

describe('release workflow contract', () => {
  type Step = { id?: string; name?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown> };
  type Job = { needs?: string; if?: string; environment?: string; permissions: Record<string, string>; steps: Step[] };

  it('publishes verified main heads automatically or by dispatch through a branch-restricted environment', async () => {
    const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8')) as {
      on: {
        workflow_run: { workflows: string[]; types: string[]; branches: string[] };
        schedule: { cron: string }[];
        workflow_dispatch: { inputs: Record<string, { default?: unknown; options?: string[] }> };
      };
      permissions: Record<string, string>;
      jobs: Record<string, Job>;
    };
    expect(Object.keys(workflow.on)).toEqual(['workflow_run', 'schedule', 'workflow_dispatch']);
    expect(workflow.on.workflow_run).toEqual({ workflows: ['Model-free CI'], types: ['completed'], branches: ['main'] });
    expect(workflow.on.schedule).toHaveLength(1);
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.bump!.options).toEqual(['patch', 'minor', 'major']);
    expect(inputs.prerelease!.default).toBe(true);
    expect(inputs.dry_run!.default).toBe(true);
    expect(workflow.permissions).toEqual({ contents: 'read' });

    const verify = workflow.jobs.verify!;
    expect(verify.if).toContain("vars.AUTO_RELEASE == 'true'");
    expect(verify.if).toContain("github.event.workflow_run.event == 'push'");
    expect(verify.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(verify.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(verify.steps[0]).toMatchObject({ if: "github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main'" });
    const runs = verify.steps.map((step) => step.run ?? '');
    const order = ['git rev-parse HEAD', 'tooling/release.mjs plan patch', 'actions/workflows/ci.yml/runs?head_sha=$SHA&event=push&branch=main&status=success', 'pnpm check', 'git status --porcelain']
      .map((text) => runs.findIndex((run) => run.includes(text)));
    expect(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]!))).toBe(true);
    for (const step of verify.steps.slice(order[3]!)) expect(step.if).toBe("steps.ci.outputs.release == 'true'");
    const checkout = verify.steps.find((step) => step.uses === 'actions/checkout@v7')!;
    expect(checkout.with).toMatchObject({ ref: 'main', 'persist-credentials': false });

    const publish = workflow.jobs.publish!;
    expect(publish).toMatchObject({ needs: 'verify', if: "needs.verify.outputs.release == 'true' && inputs.dry_run != true", environment: 'release' });
    expect(publish.permissions).toEqual({ actions: 'read', contents: 'write' });
    const pinned = publish.steps.filter((step) => step.uses).map((step) => step.uses);
    expect(pinned).toHaveLength(2);
    expect(pinned[0]).toBe('actions/checkout@v7');
    expect(pinned[1]).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(publish.steps.find((step) => step.uses === 'actions/checkout@v7')!.with).toMatchObject({ 'persist-credentials': false });
    const publishRuns = publish.steps.map((step) => step.run ?? '');
    const branchPolicy = publishRuns.findIndex((run) => run.includes('.deployment_branch_policy != null'));
    const recheck = publishRuns.findIndex((run) => run.includes('tooling/release.mjs recheck'));
    const firstWrite = publishRuns.findIndex((run) => run.includes('git/tags'));
    expect(branchPolicy).toBe(0);
    expect(recheck).toBeGreaterThan(branchPolicy);
    expect(recheck).toBeLessThan(firstWrite);
    const script = publishRuns.join('\n');
    expect(script).not.toContain('required_reviewers');
    expect(script).toContain('isDraft,isPrerelease');
    expect(script).toContain('gh release create "$TAG"');
    expect(script).toContain('--verify-tag');
    expect(script).toContain('refs/tags/$ALIAS');
    expect(script).not.toMatch(/git push|--tags/);
  });
});

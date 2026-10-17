import { afterEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { invokeVally, nativeArguments, nativeEnvironment, parseNativeEvidence, runNative } from '../src/native.js';
import { parseInputs } from '../src/inputs.js';
import { sha256, type EngineIdentity } from '../src/tooling.js';
import { inertEnvironment } from '../src/policy.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'evals native ')); directories.push(directory); return directory;
}
const inputs = (overrides: Record<string, string> = {}) => parseInputs((key) => ({
  command: 'run', 'working-directory': '.', 'eval-paths': 'pass.eval.yaml', ...overrides,
})[key] ?? '');

describe('direct CLI translation', () => {
  it('passes explicit argv without shell interpolation and preserves native override semantics', () => {
    const parsed = inputs({
      'eval-paths': ' path with spaces.yaml \nsecond.yaml', tags: 'cost=free\nflaky!=yes',
      model: 'one,two', runs: '3', workers: '4', timeout: '60', 'max-retries': '0',
    });
    const [args] = nativeArguments(parsed, resolve('project'), resolve('output'), 'run-id');
    expect(args).toContain('--require-pass');
    expect(args).toContain(`--eval-spec=${resolve('project', ' path with spaces.yaml ')}`);
    expect(args).toContain('--tag=flaky!=yes');
    expect(args).toContain('--model=one,two');
    expect(args).toContain('--timeout=60s');
    expect(args).toContain('--max-retries=0');
    expect(nativeArguments(inputs({ 'eval-paths': '', suite: '--danger' }), '.', '.', 'id')[0]).toContain('--suite=--danger');
    expect(nativeArguments(inputs({ command: 'lint', 'eval-paths': 'one.yaml\ntwo.yaml', suite: 'smoke', tags: 'cost=free' }), '.', '.', 'id'))
      .toEqual([['lint', `--eval-spec=${resolve('.')}`]]);
    expect(nativeArguments(inputs(), '.', '.', 'id')[0]).not.toContain('--workers=1');
  });
  it('refuses unsupported native plan/lint and selection combinations, never replacing them with a run', () => {
    for (const values of [
      { command: 'plan' },
      { command: 'lint', runs: '2' }, { suite: 'smoke' },
    ]) expect(() => nativeArguments(inputs(values), '.', '.', 'id')).toThrow();
  });
  it('separates model credentials from installation, preview, reporting and process injection', () => {
    const source = { COPILOT_GITHUB_TOKEN: 'model', OPENAI_API_KEY: 'byok', GITHUB_TOKEN: 'report', ACTIONS_RUNTIME_TOKEN: 'artifact', PATH: '/bin', NODE_OPTIONS: 'unsafe' };
    expect(nativeEnvironment(inputs({ command: 'lint' }), source, '/home', 'report')).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
    expect(nativeEnvironment(inputs({ 'credential-env': 'OPENAI_API_KEY' }), source, '/home', 'report'))
      .toMatchObject({ COPILOT_GITHUB_TOKEN: 'model', OPENAI_API_KEY: 'byok', VALLY_TELEMETRY_OPTOUT: '1' });
    for (const name of ['GITHUB_TOKEN', 'NODE_OPTIONS', 'LD_PRELOAD', 'BASH_ENV', 'bad-name']) {
      expect(() => nativeEnvironment(inputs({ 'credential-env': name }), source, '/home', 'report')).toThrow();
    }
    expect(() => nativeEnvironment(inputs(), { COPILOT_GITHUB_TOKEN: 'report' }, '/home', 'report')).toThrow(/reporting-token/);
  });
});

function evidence(passed = true) {
  const trial = { type: 'trial-result', runId: 'id', itemId: 'item', evalFilePath: '/private/eval.yaml', variant: 'default', stimulus: 'case', status: 'success', gradeResult: { passed, score: passed ? 1 : 0 }, trajectory: { id: 'trajectory', output: 'private prompt' } };
  const summary = { type: 'run-summary', runId: 'id', passed, hadExecutionErrors: false, evals: [{ evalFilePath: trial.evalFilePath, variant: 'default', passed, scoringApplied: false, stimuliRun: 1, stimuliTotal: 1 }] };
  return { trial, summary, text: [trial, summary].map((row) => JSON.stringify(row)).join('\n') };
}

describe('native evidence projection', () => {
  it('uses the native verdict, including a failed verdict with process exit zero', () => {
    expect(parseNativeEvidence(evidence().text, 'id', 0)).toMatchObject({ outcome: 'passed', executed: 1, passed: 1, failed: 0 });
    expect(parseNativeEvidence(evidence(false).text, 'id', 0)).toMatchObject({ outcome: 'failed', failed: 1 });
    expect(parseNativeEvidence(evidence().text, 'id', 1)).toMatchObject({ outcome: 'error', code: 'native-process-failed' });
    expect(JSON.stringify(parseNativeEvidence(evidence().text, 'id', 0))).not.toMatch(/private|prompt/);
  });
  it('requires a unique complete terminal summary, identity and count consistency', () => {
    const { trial, summary } = evidence();
    for (const rows of [
      [], [trial], [trial, summary, summary], [summary, trial], [{ ...trial, runId: 'wrong' }, summary],
      [trial, trial, summary], [trial, { ...summary, evals: [] }],
      [trial, { ...summary, evals: [{ ...summary.evals[0], stimuliRun: 2 }] }],
      [trial, { ...summary, evals: [null] }], [{ ...trial, trajectory: null }, summary],
    ]) expect(() => parseNativeEvidence(rows.map((row) => JSON.stringify(row)).join('\n'), 'id', 0)).toThrow();
    expect(() => parseNativeEvidence('not json', 'id', 0)).toThrow(/malformed/);
  });
  it('distinguishes proven empty evidence from errors, without softening native nonzero exits', () => {
    const empty = { ...evidence().summary, evals: [] };
    expect(parseNativeEvidence(JSON.stringify(empty), 'id', 0)).toMatchObject({ outcome: 'not-run', executed: 0 });
    expect(parseNativeEvidence(JSON.stringify(empty), 'id', 1)).toMatchObject({ outcome: 'error' });
    const { trial, summary } = evidence();
    expect(parseNativeEvidence([trial, { ...summary, hadExecutionErrors: true }].map((row) => JSON.stringify(row)).join('\n'), 'id', 1))
      .toMatchObject({ outcome: 'error', category: 'execution' });
  });
  it('accepts explicit null grades and distinguishes nested grader errors from negative verdicts', () => {
    const { trial, summary } = evidence();
    const format = (gradeResult: unknown) => [{ ...trial, gradeResult }, summary].map((row) => JSON.stringify(row)).join('\n');
    expect(parseNativeEvidence(format(null), 'id', 0)).toMatchObject({ outcome: 'passed' });
    expect(parseNativeEvidence(format({
      passed: false, score: 0,
      details: [{ passed: false, score: 0, details: [{ passed: false, score: 0, status: 'error' }] }],
    }), 'id', 1)).toMatchObject({ outcome: 'error', category: 'execution' });
    expect(() => parseNativeEvidence(format({ passed: true, score: 1, details: 'invalid' }), 'id', 0)).toThrow();
  });
});

async function nativeFixture() {
  const root = await temporary();
  const project = join(root, 'project with spaces');
  const output = join(root, 'native output');
  await cp(resolve('tests', 'fixtures'), project, { recursive: true });
  await mkdir(output);
  const manifest = createRequire(import.meta.url).resolve('@microsoft/vally-cli/package.json');
  const entry = join(dirname(manifest), 'dist', 'index.js');
  const engine: EngineIdentity = {
    entry, version: '0.19.0', sha256: sha256(await readFile(entry)),
    integrity: 'pinned-development-fixture', dependencySha256: 'development-lockfile', lockSha256: 'development-lockfile',
  };
  return { root, project, output, engine };
}

describe('real Vally CLI, built-in mock executor, no models', () => {
  it('lints the entire project without selectors and catches invalid nested evals outside supplied selections', async () => {
    const fixture = await nativeFixture();
    const selected = inputs({ command: 'lint', 'eval-paths': '' });
    const env = nativeEnvironment(selected, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, fixture.root, '');
    const valid = await runNative(selected, fixture.engine, fixture.project, fixture.output, env);
    expect(valid.result).toMatchObject({ outcome: 'validated', executed: 0 });
    await mkdir(join(fixture.project, 'nested'));
    await writeFile(join(fixture.project, 'nested', 'invalid.eval.yaml'), 'name: [broken');
    const invalid = await runNative(inputs({ command: 'lint', 'eval-paths': 'pass.eval.yaml', suite: 'smoke', tags: 'cost=free' }), fixture.engine, fixture.project, fixture.output, env);
    expect(invalid.result).toMatchObject({ outcome: 'error', code: 'native-lint-failed' });
  }, 30_000);
  it('runs an actual suite and respects native weighted thresholds instead of all-graders-pass rules', async () => {
    const fixture = await nativeFixture();
    const selected = inputs({ 'eval-paths': '', suite: 'smoke', runs: '2', model: 'one,two' });
    const env = nativeEnvironment(selected, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, fixture.root, '');
    const actual = await runNative(selected, fixture.engine, fixture.project, fixture.output, env);
    expect(actual.result).toMatchObject({ outcome: 'passed', executed: 4, passed: 2, failed: 0 });
    expect(actual.result.groups).toHaveLength(2);
    expect(actual.files).toHaveLength(2);
  }, 30_000);
  it('fails an actual native verdict and reports a fully skipped selection as not-run', async () => {
    const fixture = await nativeFixture();
    const env = nativeEnvironment(inputs(), { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, fixture.root, '');
    const failed = await runNative(inputs({ 'eval-paths': 'fail.eval.yaml' }), fixture.engine, fixture.project, fixture.output, env);
    expect(failed.result).toMatchObject({ outcome: 'failed', executed: 1, failed: 1 });
    const skipped = await runNative(inputs({ 'eval-paths': 'skipped.eval.yaml' }), fixture.engine, fixture.project, fixture.output, env);
    expect(skipped.result).toMatchObject({ outcome: 'not-run', executed: 0 });
  }, 30_000);
  it('does not turn missing suites or evidence-free discovery into success', async () => {
    const fixture = await nativeFixture();
    const env = nativeEnvironment(inputs(), { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, fixture.root, '');
    for (const suite of ['missing', 'empty']) {
      const actual = await runNative(inputs({ 'eval-paths': '', suite }), fixture.engine, fixture.project, fixture.output, env);
      expect(actual.result).toMatchObject({ outcome: 'error', code: 'native-run-summary-missing' });
    }
  }, 30_000);
  it('refuses changed executable identity and mismatched native versions', async () => {
    const fixture = await nativeFixture();
    const env = nativeEnvironment(inputs(), { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, fixture.root, '');
    await expect(runNative(inputs(), { ...fixture.engine, sha256: 'wrong' }, fixture.project, fixture.output, env)).rejects.toThrow(/executable-changed/);
    await expect(runNative(inputs(), { ...fixture.engine, version: '0.18.0' }, fixture.project, fixture.output, env)).rejects.toThrow(/version-mismatch/);
  }, 30_000);
  it('preserves actual ungraded runs and native grader operational errors', async () => {
    const fixture = await nativeFixture();
    const env = nativeEnvironment(inputs(), { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, fixture.root, '');
    const ungraded = await runNative(inputs({ 'eval-paths': 'ungraded.eval.yaml' }), fixture.engine, fixture.project, fixture.output, env);
    expect(ungraded.result).toMatchObject({ outcome: 'passed', executed: 1, passed: 1 });
    const brokenGrader = await runNative(inputs({ 'eval-paths': 'grader-error.eval.yaml' }), fixture.engine, fixture.project, fixture.output, env);
    expect(brokenGrader.result).toMatchObject({ outcome: 'error', category: 'execution', code: 'native-execution-error' });
    expect(brokenGrader.result).not.toHaveProperty('failed');
  }, 30_000);
});

it('forwards cancellation to an owned model-free child and removes its process listeners', async () => {
  const root = await temporary();
  const entry = join(root, 'signal-child.cjs');
  const ready = join(root, 'ready');
  await writeFile(entry, "process.on('SIGINT', () => process.exit(130)); require('node:fs').writeFileSync(process.env.READY_FILE, 'ready'); setInterval(() => {}, 1000);");
  const engine: EngineIdentity = { entry, version: 'synthetic', integrity: '', sha256: '', dependencySha256: '', lockSha256: '' };
  const previous = process.listeners('SIGTERM');
  const child = invokeVally(engine, ['eval'], root, { ...inertEnvironment(process.env), READY_FILE: ready }, root);
  let result;
  try {
    await vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toBe('ready'), { timeout: 5000 });
  } finally {
    const cancel = process.listeners('SIGTERM').find((listener) => !previous.includes(listener));
    expect(cancel).toBeDefined();
    cancel!('SIGTERM');
    result = await child;
  }
  expect(result.cancelled).toBe(true);
  expect(process.listeners('SIGTERM')).toEqual(previous);
}, 35_000);

it('reports child startup errors without swallowing them', async () => {
  const root = await temporary();
  const engine: EngineIdentity = { entry: 'unused', version: 'synthetic', integrity: '', sha256: '', dependencySha256: '', lockSha256: '' };
  await expect(invokeVally(engine, ['--version'], join(root, 'missing'), inertEnvironment(process.env), root)).rejects.toThrow(/process-start-failed/);
});

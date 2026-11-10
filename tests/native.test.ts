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
const NATIVE_TEST_TIMEOUT_MS = 90_000;
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'evals native ')); directories.push(directory); return directory;
}
const inputs = (overrides: Record<string, string> = {}) => parseInputs((key) => ({
  command: 'run', 'working-directory': '.', 'eval-paths': 'pass.eval.yaml', ...overrides,
})[key] ?? '');
const telemetryControls = ['VALLY_TELEMETRY_OPTOUT', 'DO_NOT_TRACK', 'OTEL_SDK_DISABLED'] as const;
const telemetryCases: NodeJS.ProcessEnv[] = [
  {},
  ...telemetryControls.flatMap((name) => ['1', '0', 'true', 'false', ''].map((value) => ({ [name]: value }))),
  { VALLY_TELEMETRY_OPTOUT: '1', DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true' },
  { VALLY_TELEMETRY_OPTOUT: '0', DO_NOT_TRACK: '', OTEL_SDK_DISABLED: 'false' },
];

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
  it('keeps adversarial native selectors as single argv values without shell execution', async () => {
    const root = await temporary();
    const captured = join(root, 'argv.json');
    const marker = join(root, 'shell-marker');
    const entry = join(root, 'capture.cjs');
    await writeFile(entry, [
      "require('node:fs').writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
      "setTimeout(() => {}, 10);",
    ].join('\n'));
    const parsed = inputs({
      'eval-paths': 'eval path;echo path.yaml',
      tags: `cost=free,low\nflaky!=yes;touch ${marker}`,
    });
    const args = nativeArguments(parsed, root, root, 'run-id')[0]!;
    expect(args).toContain('--tag=cost=free,low');
    expect(args).toContain(`--tag=flaky!=yes;touch ${marker}`);
    expect(args).toContain(`--eval-spec=${resolve(root, 'eval path;echo path.yaml')}`);
    const result = await invokeVally(
      { entry, version: 'synthetic', integrity: '', sha256: '', dependencySha256: '', lockSha256: '' },
      args, root, { ARGV_FILE: captured }, root,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(captured, 'utf8'))).toEqual(args);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses unsupported native plan/lint and selection combinations, never replacing them with a run', () => {
    for (const values of [
      { command: 'plan' },
      { command: 'lint', runs: '2' }, { suite: 'smoke' },
    ]) expect(() => nativeArguments(inputs(values), '.', '.', 'id')).toThrow();
  });
  it.each(['run', 'lint'])('preserves Vally defaults and exact caller telemetry controls for %s', (command) => {
    for (const controls of telemetryCases) {
      const source = {
        ...controls, PATH: '/bin', HOME: '/caller-home', COPILOT_GITHUB_TOKEN: 'model',
        GITHUB_TOKEN: 'report', GH_TOKEN: 'gh', ACTIONS_RUNTIME_TOKEN: 'artifact', NODE_OPTIONS: 'unsafe',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://untrusted.invalid', OTEL_EXPORTER_OTLP_HEADERS: 'private-header',
      };
      const original = { ...source };
      const env = nativeEnvironment(inputs({ command }), source, '/isolated-home', 'report');
      for (const name of telemetryControls) {
        if (controls[name] === undefined) expect(env).not.toHaveProperty(name);
        else expect(env).toHaveProperty(name, controls[name]);
      }
      expect(env.HOME).toBe('/isolated-home');
      for (const name of [
        'COPILOT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NODE_OPTIONS',
        'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS',
      ]) expect(env).not.toHaveProperty(name);
      expect(source).toEqual(original);
    }
  });
  it('separates model credentials from installation, preview, reporting and process injection', () => {
    const source = { COPILOT_GITHUB_TOKEN: 'model', OPENAI_API_KEY: 'byok', GITHUB_TOKEN: 'report', ACTIONS_RUNTIME_TOKEN: 'artifact', PATH: '/bin', NODE_OPTIONS: 'unsafe' };
    const unlisted = nativeEnvironment(inputs(), source, '/home', 'report');
    for (const name of ['COPILOT_GITHUB_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NODE_OPTIONS']) {
      expect(unlisted).not.toHaveProperty(name);
    }
    const byok = nativeEnvironment(inputs({ 'credential-env': 'OPENAI_API_KEY' }), source, '/home', 'report');
    expect(byok).toHaveProperty('OPENAI_API_KEY', 'byok');
    expect(byok).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
    expect(nativeEnvironment(inputs({ 'credential-env': 'COPILOT_GITHUB_TOKEN' }), source, '/home', 'report'))
      .toHaveProperty('COPILOT_GITHUB_TOKEN', 'model');
    for (const command of ['lint', 'plan']) {
      const preview = nativeEnvironment(inputs({ command, 'credential-env': 'COPILOT_GITHUB_TOKEN\nOPENAI_API_KEY' }), source, '/home', 'report');
      expect(preview).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
      expect(preview).not.toHaveProperty('OPENAI_API_KEY');
    }
    for (const name of ['GITHUB_TOKEN', 'NODE_OPTIONS', 'LD_PRELOAD', 'BASH_ENV', 'bad-name']) {
      expect(() => nativeEnvironment(inputs({ 'credential-env': name }), source, '/home', 'report')).toThrow();
    }
    expect(() => nativeEnvironment(inputs({ 'credential-env': 'COPILOT_GITHUB_TOKEN' }), { COPILOT_GITHUB_TOKEN: 'report' }, '/home', 'report'))
      .toThrow(/reporting-token/);
  });
  it('allows explicit workflow-token authentication only through the Copilot environment alias', () => {
    const token = 'synthetic-actions-token';
    const source = {
      GITHUB_TOKEN: token, COPILOT_GITHUB_TOKEN: token, OPENAI_API_KEY: token,
      GH_TOKEN: 'separate-gh-token', ACTIONS_RUNTIME_TOKEN: 'artifact-token', PATH: '/bin',
    };
    const selected = inputs({ 'credential-env': 'COPILOT_GITHUB_TOKEN' });
    const env = nativeEnvironment(selected, source, '/isolated-home', '');
    expect(env.COPILOT_GITHUB_TOKEN).toBe(token);
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_COPILOT_API_TOKEN']) {
      expect(env).not.toHaveProperty(name);
    }
    expect(nativeEnvironment(inputs(), source, '/isolated-home', '')).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
    for (const command of ['lint', 'plan']) {
      expect(nativeEnvironment(inputs({ command, 'credential-env': 'COPILOT_GITHUB_TOKEN' }), source, '/isolated-home', ''))
        .not.toHaveProperty('COPILOT_GITHUB_TOKEN');
    }
    expect(() => nativeEnvironment(selected, source, '/isolated-home', token)).toThrow(/reporting-token/);
    expect(() => nativeEnvironment(inputs({ 'credential-env': 'OPENAI_API_KEY' }), source, '/isolated-home', '')).toThrow(/reporting-token/);
    expect(() => nativeEnvironment(selected, { ...source, COPILOT_GITHUB_TOKEN: source.ACTIONS_RUNTIME_TOKEN }, '/isolated-home', '')).toThrow(/reporting-token/);
    expect(() => nativeEnvironment(selected, { ...source, COPILOT_GITHUB_TOKEN: source.GH_TOKEN }, '/isolated-home', '')).toThrow(/reporting-token/);
  });
  it('maps the dedicated Copilot token input into the environment path with no ambient fallback', () => {
    const token = 'synthetic-input-token';
    const selected = inputs();
    const env = nativeEnvironment(selected, { GITHUB_TOKEN: token, PATH: '/bin' }, '/home', '', token);
    expect(env.COPILOT_GITHUB_TOKEN).toBe(token);
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(nativeEnvironment(selected, { GITHUB_TOKEN: token, PATH: '/bin' }, '/home', '')).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
    expect(() => nativeEnvironment(inputs({ 'credential-env': 'COPILOT_GITHUB_TOKEN' }), { PATH: '/bin' }, '/home', '', token))
      .toThrow(/cannot-combine/);
    expect(() => nativeEnvironment(selected, { PATH: '/bin' }, '/home', token, token)).toThrow(/reporting-token/);
    expect(() => nativeEnvironment(selected, { GH_TOKEN: token, PATH: '/bin' }, '/home', '', token)).toThrow(/reporting-token/);
    expect(() => nativeEnvironment(selected, { ACTIONS_RUNTIME_TOKEN: token, PATH: '/bin' }, '/home', '', token)).toThrow(/reporting-token/);
    for (const command of ['lint', 'plan']) {
      expect(nativeEnvironment(inputs({ command }), { PATH: '/bin' }, '/home', '', token)).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
    }
  });
  it('transports a workflow token through the child environment, never argv or the version check', async () => {
    const root = await temporary();
    const entry = join(root, 'auth-control.cjs');
    const token = 'synthetic-workflow-token';
    await writeFile(entry, [
      "const assert = require('node:assert/strict');",
      "assert.ok(!JSON.stringify(process.argv).includes('synthetic-workflow-token'));",
      "for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_COPILOT_API_TOKEN']) assert.equal(process.env[name], undefined);",
      "if (process.argv[2] === '--version') {",
      "  assert.equal(process.env.COPILOT_GITHUB_TOKEN, undefined); console.log('0.19.0');",
      "} else {",
      "  assert.equal(process.env.COPILOT_GITHUB_TOKEN, 'synthetic-workflow-token');",
      "  const runId = process.argv.find(arg => arg.startsWith('--run-id=')).slice('--run-id='.length);",
      "  console.log(JSON.stringify({type: 'run-summary', runId, passed: true, hadExecutionErrors: false, evals: []}));",
      "}",
    ].join('\n'));
    const engine: EngineIdentity = { entry, version: '0.19.0', integrity: 'synthetic', sha256: sha256(await readFile(entry)), dependencySha256: '', lockSha256: '' };
    const selected = inputs({ 'credential-env': 'COPILOT_GITHUB_TOKEN' });
    const env = nativeEnvironment(selected, { ...inertEnvironment(process.env), COPILOT_GITHUB_TOKEN: token, GITHUB_TOKEN: token }, root, '');
    const actual = await runNative(selected, engine, root, root, env);
    expect(actual.result).toMatchObject({ outcome: 'not-run', code: 'native-empty-selection' });
    for (const path of actual.files) expect(await readFile(path, 'utf8')).not.toContain(token);
  });
  it.each(['run', 'lint'])('transports caller telemetry settings through --version and %s without forced opt-outs', async (command) => {
    for (const controls of [telemetryCases[0]!, ...telemetryCases.slice(-2)]) {
      const root = await temporary();
      const entry = join(root, 'telemetry-control.cjs');
      await writeFile(entry, [
        "const assert = require('node:assert/strict');",
        `const expected = ${JSON.stringify(controls)};`,
        `for (const name of ${JSON.stringify(telemetryControls)}) assert.equal(process.env[name], expected[name]);`,
        "for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NODE_OPTIONS', 'OTEL_EXPORTER_OTLP_HEADERS']) assert.equal(process.env[name], undefined);",
        "assert.ok(!JSON.stringify(process.argv).includes('synthetic-model-token'));",
        "if (process.argv[2] === '--version') {",
        "  assert.equal(process.env.COPILOT_GITHUB_TOKEN, undefined); console.log('0.19.0');",
        "} else if (process.argv[2] === 'lint') {",
        "  assert.equal(process.env.COPILOT_GITHUB_TOKEN, undefined);",
        "} else {",
        "  assert.equal(process.env.COPILOT_GITHUB_TOKEN, 'synthetic-model-token');",
        "  const runId = process.argv.find(arg => arg.startsWith('--run-id=')).slice('--run-id='.length);",
        "  console.log(JSON.stringify({type: 'run-summary', runId, passed: true, hadExecutionErrors: false, evals: []}));",
        "}",
      ].join('\n'));
      const engine: EngineIdentity = { entry, version: '0.19.0', integrity: 'synthetic', sha256: sha256(await readFile(entry)), dependencySha256: '', lockSha256: '' };
      const selected = inputs({ command, 'credential-env': 'COPILOT_GITHUB_TOKEN' });
      const env = nativeEnvironment(selected, {
        ...inertEnvironment(process.env), ...Object.fromEntries(telemetryControls.map((name) => [name, undefined])),
        ...controls, COPILOT_GITHUB_TOKEN: 'synthetic-model-token', GITHUB_TOKEN: 'synthetic-report-token',
        NODE_OPTIONS: 'unsafe', OTEL_EXPORTER_OTLP_HEADERS: 'private-header',
      }, root, 'synthetic-report-token');
      const original = { ...env };
      const actual = await runNative(selected, engine, root, root, env);
      expect(actual.result.outcome).toBe(command === 'run' ? 'not-run' : 'validated');
      expect(env).toEqual(original);
    }
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
  it('projects the real native trial eval name without leaking the eval file path', () => {
    const { trial, summary } = evidence();
    const result = parseNativeEvidence([
      { ...trial, evalName: 'visible-eval' }, summary,
    ].map((row) => JSON.stringify(row)).join('\n'), 'id', 0);
    expect(result.groups?.[0]?.name).toBe('visible-eval');
    expect(JSON.stringify(result)).not.toContain('/private/');
    expect(() => parseNativeEvidence([
      { ...trial, evalName: 'bad\nname' }, summary,
    ].map((row) => JSON.stringify(row)).join('\n'), 'id', 0)).toThrow(/eval-name/);
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
  it('extracts overallScore, threshold, durationMs, and token usage at the group level without leaking stimulus names', () => {
    const trial1 = {
      type: 'trial-result', runId: 'id', itemId: 'item-1', evalFilePath: '/private/eval.yaml',
      evalName: 'skill-eval', variant: 'default', stimulus: 'private-case-alpha', status: 'success',
      durationMs: 120,
      gradeResult: { passed: true, score: 0.95 },
      trajectory: { id: 't1', output: 'ok', metrics: { tokenUsage: { inputTokens: 300, outputTokens: 150, totalTokens: 450 } } },
    };
    const trial2 = {
      type: 'trial-result', runId: 'id', itemId: 'item-2', evalFilePath: '/private/eval.yaml',
      evalName: 'skill-eval', variant: 'default', stimulus: 'private-case-beta', status: 'success',
      durationMs: 80,
      gradeResult: { passed: false, score: 0.5 },
      trajectory: { id: 't2', output: 'partial', metrics: { tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } } },
    };
    const summary = {
      type: 'run-summary', runId: 'id', passed: true, hadExecutionErrors: false,
      evals: [{
        evalFilePath: '/private/eval.yaml', variant: 'default', passed: true,
        scoringApplied: true, overallScore: 0.725, threshold: 0.7, stimuliRun: 2, stimuliTotal: 2,
      }],
    };
    const parsed = parseNativeEvidence([trial1, trial2, summary].map((row) => JSON.stringify(row)).join('\n'), 'id', 0);
    expect(parsed).toMatchObject({
      outcome: 'passed',
      executed: 2,
      passed: 1,
      failed: 0,
      durationMs: 200,
      tokens: { input: 400, output: 200, total: 600 },
    });
    expect(parsed.groups?.[0]).toMatchObject({
      name: 'skill-eval',
      passed: true,
      trials: 2,
      overallScore: 0.725,
      threshold: 0.7,
      durationMs: 200,
      tokens: { input: 400, output: 200, total: 600 },
    });
    expect(parsed.groups?.[0]).not.toHaveProperty('cases');
    expect(JSON.stringify(parsed)).not.toMatch(/private-case-alpha|private-case-beta/);

    // Partial trial duration or token coverage omits group/top-level metrics rather than reporting incomplete totals.
    const partialTrial2 = {
      ...trial2,
      durationMs: undefined,
      trajectory: { id: 't2', output: 'partial', metrics: { tokenUsage: { inputTokens: 100, totalTokens: 150 } } },
    };
    const partialParsed = parseNativeEvidence([trial1, partialTrial2, summary].map((row) => JSON.stringify(row)).join('\n'), 'id', 0);
    expect(partialParsed.durationMs).toBeUndefined();
    expect(partialParsed.groups?.[0]?.durationMs).toBeUndefined();
    expect(partialParsed.tokens).toEqual({ total: 600 });
    expect(partialParsed.groups?.[0]?.tokens).toEqual({ total: 600 });

    // Skipped (zero-trial) groups omit scoring, duration, and token metrics.
    const skippedTrial = {
      type: 'trial-result', runId: 'id', itemId: 'item-skip', evalFilePath: '/private/skipped.yaml',
      evalName: 'skipped-eval', variant: 'default', stimulus: 'private-skip', status: 'skipped',
    };
    const skippedSummary = {
      type: 'run-summary', runId: 'id', passed: true, hadExecutionErrors: false,
      evals: [{
        evalFilePath: '/private/skipped.yaml', variant: 'default', passed: true,
        scoringApplied: true, overallScore: 1, threshold: 0.8, stimuliRun: 0, stimuliTotal: 1, stimuliSkipped: 1,
      }],
    };
    const skippedParsed = parseNativeEvidence([skippedTrial, skippedSummary].map((row) => JSON.stringify(row)).join('\n'), 'id', 0);
    expect(skippedParsed.groups?.[0]).toMatchObject({ name: 'skipped-eval', trials: 0, skipped: 1 });
    expect(skippedParsed.groups?.[0]?.overallScore).toBeUndefined();
    expect(skippedParsed.groups?.[0]?.threshold).toBeUndefined();
    expect(skippedParsed.groups?.[0]?.durationMs).toBeUndefined();
    expect(skippedParsed.groups?.[0]?.tokens).toBeUndefined();

    expect(() => parseNativeEvidence([
      trial1, trial2, { ...summary, evals: [{ ...summary.evals[0], overallScore: 1.5 }] },
    ].map((row) => JSON.stringify(row)).join('\n'), 'id', 0)).toThrow(/scoring-evidence/);
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
  const source = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    VALLY_TELEMETRY_OPTOUT: '1', DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true',
  };
  return { root, project, output, engine, source };
}

describe('real Vally CLI, built-in mock executor, no models', () => {
  it('lints the entire project without selectors and catches invalid nested evals outside supplied selections', async () => {
    const fixture = await nativeFixture();
    const selected = inputs({ command: 'lint', 'eval-paths': '' });
    const env = nativeEnvironment(selected, fixture.source, fixture.root, '');
    const valid = await runNative(selected, fixture.engine, fixture.project, fixture.output, env);
    expect(valid.result).toMatchObject({ outcome: 'validated', executed: 0 });
    await mkdir(join(fixture.project, 'nested'));
    await writeFile(join(fixture.project, 'nested', 'invalid.eval.yaml'), 'name: [broken');
    const invalid = await runNative(inputs({ command: 'lint', 'eval-paths': 'pass.eval.yaml', suite: 'smoke', tags: 'cost=free' }), fixture.engine, fixture.project, fixture.output, env);
    expect(invalid.result).toMatchObject({ outcome: 'error', code: 'native-lint-failed' });
  }, NATIVE_TEST_TIMEOUT_MS);
  it('runs an actual suite and respects native weighted thresholds instead of all-graders-pass rules', async () => {
    const fixture = await nativeFixture();
    const selected = inputs({ 'eval-paths': '', suite: 'smoke', runs: '2', model: 'one,two' });
    const env = nativeEnvironment(selected, fixture.source, fixture.root, '');
    const actual = await runNative(selected, fixture.engine, fixture.project, fixture.output, env);
    expect(actual.result).toMatchObject({ outcome: 'passed', executed: 4, passed: 2, failed: 0 });
    expect(actual.result.groups).toHaveLength(2);
    expect(actual.result.groups?.map((group) => group.name)).toEqual(['deterministic-pass', 'deterministic-pass']);
    expect(actual.files).toHaveLength(2);
  }, NATIVE_TEST_TIMEOUT_MS);
  it('preserves native include, exclude and comma-separated tag filters in real CLI execution', async () => {
    const fixture = await nativeFixture();
    const selected = inputs({ tags: 'cost=free,low\ncost!=paid' });
    const env = nativeEnvironment(selected, fixture.source, fixture.root, '');
    const actual = await runNative(selected, fixture.engine, fixture.project, fixture.output, env);
    expect(actual.result).toMatchObject({ outcome: 'passed', executed: 1, passed: 1, failed: 0 });
  }, NATIVE_TEST_TIMEOUT_MS);
  it('fails an actual native verdict and reports a fully skipped selection as not-run', async () => {
    const fixture = await nativeFixture();
    const env = nativeEnvironment(inputs(), fixture.source, fixture.root, '');
    const failed = await runNative(inputs({ 'eval-paths': 'fail.eval.yaml' }), fixture.engine, fixture.project, fixture.output, env);
    expect(failed.result).toMatchObject({ outcome: 'failed', executed: 1, failed: 1 });
    const skipped = await runNative(inputs({ 'eval-paths': 'skipped.eval.yaml' }), fixture.engine, fixture.project, fixture.output, env);
    expect(skipped.result).toMatchObject({ outcome: 'not-run', executed: 0 });
  }, NATIVE_TEST_TIMEOUT_MS);
  it('does not turn missing suites or evidence-free discovery into success', async () => {
    const fixture = await nativeFixture();
    const env = nativeEnvironment(inputs(), fixture.source, fixture.root, '');
    for (const suite of ['missing', 'empty']) {
      const actual = await runNative(inputs({ 'eval-paths': '', suite }), fixture.engine, fixture.project, fixture.output, env);
      expect(actual.result).toMatchObject({ outcome: 'error', code: 'native-run-summary-missing' });
    }
  }, NATIVE_TEST_TIMEOUT_MS);
  it('refuses changed executable identity and mismatched native versions', async () => {
    const fixture = await nativeFixture();
    const env = nativeEnvironment(inputs(), fixture.source, fixture.root, '');
    await expect(runNative(inputs(), { ...fixture.engine, sha256: 'wrong' }, fixture.project, fixture.output, env)).rejects.toThrow(/executable-changed/);
    await expect(runNative(inputs(), { ...fixture.engine, version: '0.18.0' }, fixture.project, fixture.output, env)).rejects.toThrow(/version-mismatch/);
  }, NATIVE_TEST_TIMEOUT_MS);
  it('preserves actual ungraded runs and native grader operational errors', async () => {
    const fixture = await nativeFixture();
    const env = nativeEnvironment(inputs(), fixture.source, fixture.root, '');
    const ungraded = await runNative(inputs({ 'eval-paths': 'ungraded.eval.yaml' }), fixture.engine, fixture.project, fixture.output, env);
    expect(ungraded.result).toMatchObject({ outcome: 'passed', executed: 1, passed: 1 });
    const brokenGrader = await runNative(inputs({ 'eval-paths': 'grader-error.eval.yaml' }), fixture.engine, fixture.project, fixture.output, env);
    expect(brokenGrader.result).toMatchObject({ outcome: 'error', category: 'execution', code: 'native-execution-error' });
    expect(brokenGrader.result).not.toHaveProperty('failed');
  }, NATIVE_TEST_TIMEOUT_MS);
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

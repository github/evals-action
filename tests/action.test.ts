import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAction } from '../src/action.js';
import type { NativeResult } from '../src/native.js';
import { structuredReport, type Report } from '../src/reporting.js';
import type { Inputs } from '../src/inputs.js';
import { reportArtifactName } from '../src/artifacts.js';

const mocks = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  setSecret: vi.fn(), setFailed: vi.fn(), warning: vi.fn(), setOutput: vi.fn(),
  summaryRaw: vi.fn(), summaryWrite: vi.fn(async () => {}),
  upload: vi.fn<(name: string, files: string[], directory: string, options: { retentionDays: number }) => Promise<{ id: number; digest: string }>>(
    async () => ({ id: 123, digest: 'd'.repeat(64) })),
  download: vi.fn(), downloadReport: '', downloadReports: {} as Record<number, string>,
  post: vi.fn<typeof import('../src/reporter.js').postReport>(async () => 'created'),
  revision: 'a'.repeat(40),
  nativeEnv: vi.fn(), acquire: vi.fn(),
  result: {} as NativeResult,
  lintResult: {} as NativeResult, nativeCommands: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));
vi.mock('@actions/core', () => ({
  getInput: (key: string) => mocks.inputs[key] ?? '',
  setSecret: mocks.setSecret, setFailed: mocks.setFailed, warning: mocks.warning, setOutput: mocks.setOutput,
  summary: { addRaw: (value: string) => { mocks.summaryRaw(value); return { write: mocks.summaryWrite }; } },
}));
vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: class {
    uploadArtifact = mocks.upload;
    downloadArtifact = mocks.download;
  },
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async () => ({ stdout: mocks.revision, stderr: '' }),
  }),
}));
vi.mock('../src/reporter.js', () => ({ postReport: mocks.post }));
vi.mock('../src/tooling.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/tooling.js')>(),
  resolveRelease: async () => ({ version: '0.19.0', integrity: 'synthetic' }),
  acquireEngine: async () => { mocks.acquire(); return { version: '0.19.0', sha256: 'a'.repeat(64), entry: 'synthetic', dependencySha256: 'b'.repeat(64), lockSha256: 'c'.repeat(64) }; },
}));
vi.mock('../src/native.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/native.js')>(),
  runNative: async (inputs: Inputs, _engine: unknown, _cwd: string, directory: string, env: NodeJS.ProcessEnv) => {
    mocks.nativeCommands(inputs);
    mocks.nativeEnv(env);
    const file = join(directory, 'native.stdout.log');
    await writeFile(file, 'synthetic native transcript');
    return { result: inputs.command === 'lint' ? mocks.lintResult : mocks.result, files: [file] };
  },
}));

let root: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.summaryWrite.mockResolvedValue(undefined);
  mocks.post.mockResolvedValue('created');
  mocks.upload.mockImplementation(async () => ({ id: 122 + mocks.upload.mock.calls.length, digest: 'd'.repeat(64) }));
  mocks.revision = 'a'.repeat(40);
  mocks.inputs = { command: 'run', 'working-directory': '.', suite: 'smoke' };
  mocks.downloadReports = {};
  mocks.fetch.mockImplementation(async () => Response.json({ artifacts: [] }));
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.result = { outcome: 'failed', completeness: 'complete', category: 'none', code: 'native-verdict-failed', executed: 1, passed: 0, failed: 1 };
  mocks.lintResult = { outcome: 'validated', completeness: 'unknown', category: 'none', code: 'native-lint-validated', executed: 0 };
  root = await mkdtemp(join(tmpdir(), 'evals-action-control-'));
  await writeFile(join(root, 'event.json'), JSON.stringify({
    number: 3, pull_request: { head: { repo: { full_name: 'o/r', fork: false } }, base: { repo: { full_name: 'o/r' } } },
  }));
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  for (const [name, value] of Object.entries({
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(root, 'event.json'),
    GITHUB_REPOSITORY: 'o/r', GITHUB_WORKSPACE: root, GITHUB_SHA: 'a'.repeat(40),
    RUNNER_TEMP: root, GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ci.yml@refs/pull/3/merge',
    GITHUB_WORKFLOW_SHA: 'b'.repeat(40), GITHUB_JOB: 'test', GITHUB_RUN_ID: '100',
    GITHUB_RUN_NUMBER: '10', GITHUB_RUN_ATTEMPT: '1',
  })) vi.stubEnv(name, value);
  mocks.download.mockImplementation(async (artifactId: number, options: { path: string; expectedHash: string }) => {
    await writeFile(join(options.path, 'report.json'), mocks.downloadReports[artifactId] ?? mocks.downloadReport);
    return { downloadPath: options.path, digestMismatch: false };
  });
});

function importedReport(overrides: Partial<Report> = {}): Report {
  return {
    schemaVersion: 2, reportId: 'evals', repository: 'o/r', workflowRunId: 100,
    workflowRunAttempt: 1, sourceJob: 'evaluate', selection: 'b'.repeat(64),
    command: 'run', outcome: 'passed', completeness: 'complete', revision: 'a'.repeat(40),
    category: 'none', code: 'native-verdict-passed', executed: 1, passed: 1, failed: 0,
    groups: [{ identity: 'c'.repeat(64), passed: true, trials: 1, stimuliRun: 1, stimuliTotal: 1, skipped: 0 }],
    ...overrides,
  };
}
function importedLint(revision = 'a'.repeat(40)): Report {
  const lint = importedReport({ reportId: 'evals-lint', command: 'lint', outcome: 'validated', executed: 0, revision });
  delete lint.passed;
  delete lint.failed;
  delete lint.groups;
  return lint;
}
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', architecture);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

it('reports the native failed verdict without initializing GitHub reporting', async () => {
  mocks.inputs['github-token'] = 'automatic-but-unused';
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledTimes(1);
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('native-verdict-failed'));
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'failed');
  expect(mocks.setOutput).toHaveBeenCalledWith('artifact-id', 123);
  expect(mocks.setOutput).toHaveBeenCalledWith('artifact-digest', 'd'.repeat(64));
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.nativeEnv.mock.calls[0]?.[0]).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
  const directory = (await readdir(root)).find((name) => name.startsWith('evals-report-'))!;
  const stored = await readFile(join(root, directory, 'report.json'), 'utf8');
  expect(stored).toContain('"schemaVersion": 2');
  expect(stored).toContain('"suite": "smoke"');
  expect(mocks.upload.mock.calls[0]?.[0]).toMatch(/^evals-report\.evals\.run\.1\.[A-Za-z0-9]{6}$/);
});

function discovery(reports: Record<number, Report>): void {
  mocks.downloadReports = Object.fromEntries(Object.entries(reports).map(([id, report]) => [id, structuredReport(report)]));
  mocks.fetch.mockImplementation(async () => Response.json({
    artifacts: Object.entries(reports).map(([id, report]) => ({
      id: Number(id), name: reportArtifactName(report.reportId, report.command, report.workflowRunAttempt, 'ABC123'),
      digest: `sha256:${'d'.repeat(64)}`, expired: false, workflow_run: { id: report.workflowRunId },
    })),
  }));
  mocks.inputs = { command: 'report', 'github-token': 'automatic-token' };
}

it('automatically discovers shared-identity lint and run evidence and posts once without executing Vally', async () => {
  discovery({ 123: importedReport(), 124: { ...importedLint(), reportId: 'evals' } });
  await runAction();
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ reportId: 'evals' }),
    expect.objectContaining({ command: 'run', outcome: 'passed' }), 123,
    { artifactId: 124, report: expect.objectContaining({ command: 'lint', reportId: 'evals', outcome: 'validated' }) });
  expect(mocks.fetch).toHaveBeenCalledWith(
    'https://api.github.com/repos/o/r/actions/runs/100/artifacts?per_page=100&page=1',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer automatic-token' }) }),
  );
  expect(mocks.download).toHaveBeenCalledTimes(2);
  expect(mocks.download).toHaveBeenCalledWith(123, expect.objectContaining({ expectedHash: `sha256:${'d'.repeat(64)}` }));
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.nativeCommands).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
});

it.each(['validated', 'error'] as const)('reports available lint %s when no run artifact exists', async (outcome) => {
  discovery({ 124: { ...importedLint(), reportId: 'evals', outcome } });
  await runAction();
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(),
    expect.objectContaining({ command: 'lint', outcome }), 124, undefined);
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('not an evaluation pass'));
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', outcome);
});

it('supports run-only evidence, custom shared identities, and comment-token overrides', async () => {
  discovery({ 123: importedReport({ reportId: 'smoke', outcome: 'error' }) });
  mocks.inputs['report-id'] = 'smoke';
  mocks.inputs['report-token'] = 'comment-bot-token';
  await runAction();
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(mocks.setSecret).toHaveBeenCalledWith('comment-bot-token');
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ reportId: 'smoke' }),
    expect.objectContaining({ reportId: 'smoke', outcome: 'error' }), 123, undefined);
  expect(mocks.fetch.mock.calls[0]?.[1]?.headers).toHaveProperty('Authorization', 'Bearer automatic-token');
});

it('uses an explicit lint override alongside an automatically discovered run or as lint-only evidence', async () => {
  discovery({ 123: importedReport(), 124: { ...importedLint(), reportId: 'evals' } });
  mocks.inputs['lint-artifact-id'] = '125';
  mocks.inputs['lint-artifact-digest'] = 'e'.repeat(64);
  mocks.downloadReports[125] = structuredReport({ ...importedLint(), reportId: 'evals' });
  await runAction();
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalledWith(124, expect.anything());
  expect(mocks.download).toHaveBeenCalledWith(125, expect.objectContaining({ expectedHash: `sha256:${'e'.repeat(64)}` }));
  expect(mocks.post.mock.calls[0]?.[4]).toHaveProperty('artifactId', 125);
  mocks.fetch.mockResolvedValue(Response.json({ artifacts: [] }));
  mocks.post.mockClear();
  await runAction();
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(),
    expect.objectContaining({ command: 'lint' }), 125, undefined);
});

it('rejects a lint override pointing at the discovered run instead of silently ignoring it', async () => {
  discovery({ 123: importedReport() });
  mocks.inputs['lint-artifact-id'] = '123';
  mocks.inputs['lint-artifact-digest'] = 'd'.repeat(64);
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('source-artifact-command-mismatch'));
  expect(mocks.post).not.toHaveBeenCalled();
});

it('uses the report token for discovery when the automatic token is absent', async () => {
  discovery({ 123: importedReport() });
  delete mocks.inputs['github-token'];
  mocks.inputs['report-token'] = 'report-only-token';
  await runAction();
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(mocks.fetch.mock.calls[0]?.[1]?.headers).toHaveProperty('Authorization', 'Bearer report-only-token');
});

it('uses explicit shared-identity artifact pairs without discovery', async () => {
  discovery({ 123: importedReport(), 124: { ...importedLint(), reportId: 'evals' } });
  mocks.inputs['source-artifact-id'] = '123';
  mocks.inputs['source-artifact-digest'] = 'd'.repeat(64);
  mocks.inputs['lint-artifact-id'] = '124';
  mocks.inputs['lint-artifact-digest'] = 'd'.repeat(64);
  await runAction();
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.post.mock.calls[0]?.[4]).toHaveProperty('report.reportId', 'evals');
});

it('fails missing current-attempt evidence and discovery permission errors without posting or uploading', async () => {
  discovery({ 123: importedReport({ workflowRunAttempt: 2 }) });
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('report-artifacts-not-found'));
  mocks.fetch.mockResolvedValue(new Response(null, { status: 403 }));
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('github-http-403'));
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});

it.each([
  { workflowRunAttempt: 2 }, { workflowRunId: 101 }, { revision: 'f'.repeat(40) },
  { repository: 'o/other' }, { reportId: 'other' },
])('verifies discovered report contents against current identity %j', async (overrides) => {
  discovery({ 123: importedReport() });
  mocks.downloadReports[123] = structuredReport(importedReport(overrides));
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('verifies discovered command labels and archive digests before posting', async () => {
  discovery({ 123: importedReport() });
  mocks.downloadReports[123] = structuredReport({ ...importedLint(), reportId: 'evals' });
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('source-artifact-command-mismatch'));
  mocks.download.mockResolvedValue({ downloadPath: root, digestMismatch: true });
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('source-artifact-digest-mismatch'));
  expect(mocks.post).not.toHaveBeenCalled();
});

it('downloads and posts a digest-bound report without acquiring or executing Vally', async () => {
  mocks.downloadReport = structuredReport(importedReport());
  mocks.inputs = {
    command: 'report', 'source-artifact-id': '123',
    'source-artifact-digest': 'd'.repeat(64),
    'report-token': 'synthetic-report-token',
  };
  await runAction();
  expect(mocks.setSecret).toHaveBeenCalledWith('synthetic-report-token');
  expect(mocks.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    repository: 'o/r', reportId: 'evals', selection: 'b'.repeat(64), runId: 100,
  }), expect.objectContaining({ outcome: 'passed' }), 123, undefined);
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.nativeEnv).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.download).toHaveBeenCalledWith(123, expect.objectContaining({
    expectedHash: `sha256:${'d'.repeat(64)}`,
  }));
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'passed');
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it('validates both separate-job artifacts before updating one comment', async () => {
  mocks.downloadReports = {
    123: structuredReport(importedReport({ reportId: 'evals-run', suite: 'smoke' })),
    124: structuredReport(importedLint()),
  };
  mocks.inputs = {
    command: 'report', 'report-id': 'evals-run',
    'source-artifact-id': '123', 'source-artifact-digest': 'd'.repeat(64),
    'lint-artifact-id': '124', 'lint-artifact-digest': 'e'.repeat(64),
    'report-token': 'synthetic-report-token',
  };
  await runAction();
  expect(mocks.download).toHaveBeenCalledTimes(2);
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    reportId: 'evals',
  }), expect.objectContaining({ reportId: 'evals-run', suite: 'smoke' }), 123, {
    artifactId: 124, report: expect.objectContaining({ reportId: 'evals-lint', outcome: 'validated' }),
  });
  expect(mocks.setFailed).not.toHaveBeenCalled();
  mocks.post.mockClear();
  mocks.downloadReports[124] = structuredReport(importedLint('f'.repeat(40)));
  await runAction();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.setFailed).toHaveBeenCalled();
});

it('warns for stale report attempts without changing the imported verdict', async () => {
  mocks.downloadReport = structuredReport(importedReport());
  mocks.inputs = {
    command: 'report', 'source-artifact-id': '123',
    'source-artifact-digest': 'd'.repeat(64),
    'report-token': 'synthetic-report-token',
  };
  mocks.post.mockResolvedValue('stale');
  await runAction();
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('newer run'));
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
});

it('rejects an artifact digest mismatch before reading evidence or writing a comment', async () => {
  mocks.downloadReport = structuredReport(importedReport());
  mocks.inputs = {
    command: 'report', 'source-artifact-id': '123',
    'source-artifact-digest': 'd'.repeat(64),
    'report-token': 'synthetic-report-token',
  };
  mocks.download.mockResolvedValue({ downloadPath: root, digestMismatch: true });
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('source-artifact-digest-mismatch'));
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.acquire).not.toHaveBeenCalled();
});

it('does not upload replacement evidence when report inputs are invalid', async () => {
  mocks.inputs = {
    command: 'report', 'source-artifact-id': '123',
    'source-artifact-digest': 'invalid',
    'report-token': 'synthetic-report-token',
  };
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('invalid-input-or-context'));
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('does not initialize a reporting client for forks or invalid checkouts', async () => {
  await writeFile(join(root, 'event.json'), JSON.stringify({
    pull_request: { head: { repo: { full_name: 'other/r', fork: true } }, base: { repo: { full_name: 'o/r' } } },
  }));
  await runAction();
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'not-run');
  expect(mocks.setOutput).toHaveBeenCalledWith('executed', 0);
  expect(mocks.setOutput).toHaveBeenCalledWith('artifact-id', 123);
  expect(mocks.post).not.toHaveBeenCalled();
});

it('reports wrong revision and rejects report-token on execution commands', async () => {
  mocks.revision = 'c'.repeat(40);
  await runAction();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('invalid-input-or-context'));
  mocks.revision = 'a'.repeat(40);
  mocks.inputs['report-token'] = 'report';
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('report-token-only-valid-for-all-or-report'));
  expect(mocks.post).not.toHaveBeenCalled();
});

it('preserves successful, empty and cancelled native outcomes and refuses unsupported plan before acquisition', async () => {
  mocks.result = { outcome: 'passed', completeness: 'complete', category: 'none', code: 'native-verdict-passed', executed: 2, passed: 1, failed: 0 };
  await runAction();
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(mocks.setOutput).toHaveBeenCalledWith('passed', 1);
  mocks.result = { outcome: 'not-run', completeness: 'complete', category: 'none', code: 'native-empty-selection', executed: 0 };
  await runAction();
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('zero executed trials'));
  mocks.result = { outcome: 'cancelled', completeness: 'partial', category: 'execution', code: 'native-cancelled' };
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('native-cancelled'));
  mocks.acquire.mockClear();
  mocks.inputs.command = 'plan';
  await runAction();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('vally-plan-not-supported'));
});

it('fails report-only networking without rerunning Vally or uploading a replacement artifact', async () => {
  mocks.downloadReport = structuredReport(importedReport());
  mocks.inputs = {
    command: 'report', 'source-artifact-id': '123',
    'source-artifact-digest': 'd'.repeat(64),
    'report-token': 'synthetic-report-token',
  };
  mocks.post.mockRejectedValue(new Error('private exception text'));
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledTimes(1);
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('comment-reporting-failed'));
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
});

it('rejects malformed, stale-identity and execution-shaped report commands before GitHub writes', async () => {
  mocks.inputs = {
    command: 'report', 'source-artifact-id': '123',
    'source-artifact-digest': 'd'.repeat(64),
    'report-token': 'synthetic-report-token',
  };
  for (const body of [
    'not-json',
    structuredReport(importedReport({ revision: 'c'.repeat(40) })),
    structuredReport(importedReport({ workflowRunId: 101 })),
  ]) {
    vi.clearAllMocks();
    mocks.downloadReport = body;
    mocks.download.mockImplementation(async (_artifactId: number, options: { path: string }) => {
      await writeFile(join(options.path, 'report.json'), mocks.downloadReport);
      return { downloadPath: options.path, digestMismatch: false };
    });
    await runAction();
    expect(mocks.setFailed).toHaveBeenCalledTimes(1);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  }
  vi.clearAllMocks();
  mocks.downloadReport = structuredReport(importedReport());
  mocks.inputs.suite = 'must-not-run';
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('report-command-does-not-accept-execution-inputs'));
  expect(mocks.post).not.toHaveBeenCalled();
});

it('enforces platform/input guards and still writes minimal reports', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  await runAction();
  expect(mocks.post).not.toHaveBeenCalled();
  Object.defineProperty(process, 'platform', { value: 'linux' });
  mocks.inputs.command = 'invalid';
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledTimes(2);
});

it('warns when lint selectors are ignored without initializing reporting', async () => {
  mocks.inputs.command = 'lint';
  mocks.inputs['eval-paths'] = 'selected.yaml';
  mocks.inputs.tags = 'cost=free';
  mocks.result = { outcome: 'validated', completeness: 'unknown', category: 'none', code: 'native-lint-validated', executed: 0 };
  await runAction();
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('selectors are ignored for lint'));
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.setFailed).not.toHaveBeenCalled();
});

it('supports explicit workflow-token auth without reporting permissions or ambient fallback', async () => {
  const token = 'synthetic-workflow-token';
  vi.stubEnv('GITHUB_TOKEN', token);
  vi.stubEnv('COPILOT_GITHUB_TOKEN', token);
  mocks.inputs['credential-env'] = 'COPILOT_GITHUB_TOKEN';
  await runAction();
  expect(mocks.nativeEnv).toHaveBeenCalledWith(expect.objectContaining({ COPILOT_GITHUB_TOKEN: token }));
  const childEnv = mocks.nativeEnv.mock.calls[0]?.[0] as NodeJS.ProcessEnv;
  expect(childEnv).not.toHaveProperty('GITHUB_TOKEN');
  expect(mocks.post).not.toHaveBeenCalled();
  expect(JSON.stringify(mocks.setOutput.mock.calls)).not.toContain(token);
  expect(JSON.stringify(mocks.summaryRaw.mock.calls)).not.toContain(token);
});

it('maps the simple copilot-token input without retaining its Actions input variable', async () => {
  const token = 'synthetic-copilot-input';
  mocks.inputs['copilot-token'] = token;
  vi.stubEnv('INPUT_COPILOT-TOKEN', token);
  await runAction();
  expect(mocks.setSecret).toHaveBeenCalledWith(token);
  expect(process.env['INPUT_COPILOT-TOKEN']).toBeUndefined();
  expect(mocks.nativeEnv).toHaveBeenCalledWith(expect.objectContaining({ COPILOT_GITHUB_TOKEN: token }));
  const childEnv = mocks.nativeEnv.mock.calls[0]?.[0] as NodeJS.ProcessEnv;
  expect(childEnv).not.toHaveProperty('GITHUB_TOKEN');
  expect(JSON.stringify(mocks.setOutput.mock.calls)).not.toContain(token);
  expect(JSON.stringify(mocks.summaryRaw.mock.calls)).not.toContain(token);
});

it('rejects ambiguous copilot-token configuration before acquisition', async () => {
  const token = 'synthetic-copilot-input';
  mocks.inputs['copilot-token'] = token;
  mocks.inputs['credential-env'] = 'COPILOT_GITHUB_TOKEN';
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('copilot-token-input-cannot-combine'));
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.nativeEnv).not.toHaveBeenCalled();
});

it('rejects reporting tokens on run before acquisition and never starts Vally for forks', async () => {
  const token = 'synthetic-shared-token';
  vi.stubEnv('GITHUB_TOKEN', token);
  vi.stubEnv('COPILOT_GITHUB_TOKEN', token);
  mocks.inputs['credential-env'] = 'COPILOT_GITHUB_TOKEN';
  mocks.inputs['report-token'] = token;
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('report-token-only-valid-for-all-or-report'));
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.nativeEnv).not.toHaveBeenCalled();
  mocks.inputs['report-token'] = '';
  await writeFile(join(root, 'event.json'), JSON.stringify({
    pull_request: { head: { repo: { full_name: 'other/r', fork: true } }, base: { repo: { full_name: 'o/r' } } },
  }));
  await runAction();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.nativeEnv).not.toHaveBeenCalled();
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'not-run');
});

it('defaults to lint then run and posts once using the automatic shared job token', async () => {
  delete mocks.inputs.command;
  mocks.inputs['github-token'] = 'automatic-token';
  vi.stubEnv('INPUT_GITHUB-TOKEN', 'automatic-token');
  mocks.result = { outcome: 'passed', completeness: 'complete', category: 'none', code: 'native-verdict-passed', executed: 1, passed: 1, failed: 0 };
  await runAction();
  expect(mocks.nativeCommands.mock.calls.map(([input]) => input.command)).toEqual(['lint', 'run']);
  expect(mocks.nativeCommands.mock.calls[1]?.[0].overrides).toEqual({ maxRetries: 0 });
  expect(mocks.nativeEnv.mock.calls[0]?.[0]).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
  expect(mocks.nativeEnv.mock.calls[1]?.[0]).toHaveProperty('COPILOT_GITHUB_TOKEN', 'automatic-token');
  expect(process.env['INPUT_GITHUB-TOKEN']).toBeUndefined();
  expect(mocks.acquire).toHaveBeenCalledTimes(1);
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(mocks.upload.mock.calls[0]?.[0]).toMatch(/^evals-report\.evals-lint\.lint\.1\.[A-Za-z0-9]{6}$/);
  expect(mocks.upload.mock.calls[1]?.[0]).toMatch(/^evals-report\.evals\.run\.1\.[A-Za-z0-9]{6}$/);
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reportId: 'evals' }),
    expect.objectContaining({ command: 'run', suite: 'smoke', outcome: 'passed' }), 124,
    { report: expect.objectContaining({ command: 'lint', outcome: 'validated', reportId: 'evals-lint' }), artifactId: 123 });
  expect(mocks.setFailed).not.toHaveBeenCalled();
  expect(JSON.stringify(mocks.summaryRaw.mock.calls)).not.toContain('automatic-token');
  expect(JSON.stringify(mocks.setOutput.mock.calls)).not.toContain('automatic-token');
});

it.each([undefined, '1', '0', ''])('preserves caller telemetry settings in both default-all phases: %s', async (value) => {
  delete mocks.inputs.command;
  const names = ['VALLY_TELEMETRY_OPTOUT', 'DO_NOT_TRACK', 'OTEL_SDK_DISABLED'];
  for (const name of names) vi.stubEnv(name, value);
  vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'private-header');
  await runAction();
  expect(mocks.nativeCommands.mock.calls.map(([input]) => input.command)).toEqual(['lint', 'run']);
  for (const [env] of mocks.nativeEnv.mock.calls) {
    for (const name of names) {
      if (value === undefined) expect(env).not.toHaveProperty(name);
      else expect(env).toHaveProperty(name, value);
    }
    expect(env).not.toHaveProperty('OTEL_EXPORTER_OTLP_HEADERS');
  }
});

it('supports BYOK in all without also injecting the automatic Copilot token', async () => {
  mocks.inputs.command = 'all';
  mocks.inputs['github-token'] = 'automatic-report-token';
  mocks.inputs['credential-env'] = 'OPENAI_API_KEY';
  mocks.inputs['max-retries'] = '1';
  vi.stubEnv('OPENAI_API_KEY', 'byok-token');
  await runAction();
  expect(mocks.nativeEnv.mock.calls[0]?.[0]).not.toHaveProperty('OPENAI_API_KEY');
  expect(mocks.nativeEnv.mock.calls[1]?.[0]).toHaveProperty('OPENAI_API_KEY', 'byok-token');
  expect(mocks.nativeEnv.mock.calls[1]?.[0]).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
  expect(mocks.nativeCommands.mock.calls[1]?.[0].overrides).toEqual({ maxRetries: 1 });
  expect(mocks.post).toHaveBeenCalledTimes(1);
});

it('does not start the eval when lint evidence cannot be saved', async () => {
  mocks.inputs.command = 'all';
  mocks.inputs['github-token'] = 'automatic-token';
  mocks.upload.mockRejectedValue(new Error('private service message'));
  await runAction();
  expect(mocks.nativeCommands.mock.calls.map(([input]) => input.command)).toEqual(['lint']);
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post.mock.calls[0]?.[2]).toMatchObject({ outcome: 'error', code: 'structured-artifact-upload-failed' });
  expect(mocks.setFailed).toHaveBeenCalled();
});

it('skips eval after failed lint and still posts its failure once', async () => {
  mocks.inputs.command = 'all';
  mocks.inputs['github-token'] = 'automatic-token';
  mocks.lintResult = { outcome: 'error', category: 'configuration', code: 'native-lint-failed', completeness: 'unknown', executed: 0 };
  await runAction();
  expect(mocks.nativeCommands.mock.calls.map(([input]) => input.command)).toEqual(['lint']);
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('native-lint-failed'));
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post.mock.calls[0]?.[2]).toMatchObject({ command: 'lint', outcome: 'error' });
});

it('keeps a native eval failure failed after successful PR reporting', async () => {
  mocks.inputs.command = 'all';
  mocks.inputs['github-token'] = 'automatic-token';
  await runAction();
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'failed');
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('native-verdict-failed'));
});

it('keeps native outputs when comment or artifact publication fails', async () => {
  mocks.inputs.command = 'all';
  mocks.inputs['github-token'] = 'automatic-token';
  mocks.post.mockRejectedValue(new Error('private transport text'));
  mocks.upload.mockImplementation(async () => {
    if (mocks.upload.mock.calls.length === 2) throw new Error('private artifact failure');
    return { id: 123, digest: 'd'.repeat(64) };
  });
  await runAction();
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post.mock.calls[0]?.[3]).toBeUndefined();
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'failed');
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('Required structured reporting failed'));
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('PR reporting failed'));
  expect(JSON.stringify(mocks.setFailed.mock.calls)).not.toContain('private');
});

it('reports invalid all-mode selection without acquiring or executing Vally', async () => {
  mocks.inputs = { 'working-directory': '.', 'github-token': 'automatic-token' };
  await runAction();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.nativeCommands).not.toHaveBeenCalled();
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.setFailed).toHaveBeenCalled();
});

it('does not post on manual dispatch or provide credentials to fork code', async () => {
  mocks.inputs.command = 'all';
  mocks.inputs['github-token'] = 'automatic-token';
  vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
  await runAction();
  expect(mocks.nativeCommands).toHaveBeenCalledTimes(2);
  expect(mocks.post).not.toHaveBeenCalled();
  vi.clearAllMocks();
  vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
  await writeFile(join(root, 'event.json'), JSON.stringify({
    number: 3, pull_request: { head: { repo: { full_name: 'other/r', fork: true } }, base: { repo: { full_name: 'o/r' } } },
  }));
  await runAction();
  expect(mocks.nativeCommands).not.toHaveBeenCalled();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

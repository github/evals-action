import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAction } from '../src/action.js';
import type { NativeResult } from '../src/native.js';
import { structuredReport, type Report } from '../src/reporting.js';

const mocks = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  setSecret: vi.fn(), setFailed: vi.fn(), warning: vi.fn(), setOutput: vi.fn(),
  summaryRaw: vi.fn(), summaryWrite: vi.fn(async () => {}),
  upload: vi.fn(async () => ({ id: 123, digest: 'd'.repeat(64) })),
  download: vi.fn(), downloadReport: '',
  post: vi.fn(async () => 'created'),
  revision: 'a'.repeat(40),
  nativeEnv: vi.fn(), acquire: vi.fn(),
  result: {} as NativeResult,
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
  runNative: async (_inputs: unknown, _engine: unknown, _cwd: string, directory: string, env: NodeJS.ProcessEnv) => {
    mocks.nativeEnv(env);
    const file = join(directory, 'native.stdout.log');
    await writeFile(file, 'synthetic native transcript');
    return { result: mocks.result, files: [file] };
  },
}));

let root: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.summaryWrite.mockResolvedValue(undefined);
  mocks.post.mockResolvedValue('created');
  mocks.revision = 'a'.repeat(40);
  mocks.inputs = { command: 'run', 'working-directory': '.', suite: 'smoke' };
  mocks.result = { outcome: 'failed', completeness: 'complete', category: 'none', code: 'native-verdict-failed', executed: 1, passed: 0, failed: 1 };
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
  mocks.download.mockImplementation(async (_artifactId: number, options: { path: string; expectedHash: string }) => {
    await writeFile(join(options.path, 'report.json'), mocks.downloadReport);
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
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', architecture);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('reports the native failed verdict without initializing GitHub reporting', async () => {
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledTimes(1);
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('native-verdict-failed'));
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'failed');
  expect(mocks.setOutput).toHaveBeenCalledWith('artifact-id', 123);
  expect(mocks.setOutput).toHaveBeenCalledWith('artifact-digest', 'd'.repeat(64));
  expect(mocks.post).not.toHaveBeenCalled();
  const directory = (await readdir(root)).find((name) => name.startsWith('evals-report-'))!;
  const stored = await readFile(join(root, directory, 'report.json'), 'utf8');
  expect(stored).toContain('"schemaVersion": 2');
  expect(stored).not.toContain('smoke');
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
  }), expect.objectContaining({ outcome: 'passed' }), 123);
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.nativeEnv).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.download).toHaveBeenCalledWith(123, expect.objectContaining({
    expectedHash: `sha256:${'d'.repeat(64)}`,
  }));
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'passed');
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
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('report-token-only-valid-for-report'));
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
  mocks.inputs.command = '';
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
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('report-token-only-valid-for-report'));
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

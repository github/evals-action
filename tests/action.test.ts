import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAction } from '../src/action.js';
import { ReportingError } from '../src/github.js';
import type { NativeResult } from '../src/native.js';

const mocks = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  setSecret: vi.fn(), setFailed: vi.fn(), warning: vi.fn(), setOutput: vi.fn(),
  summaryRaw: vi.fn(), summaryWrite: vi.fn(async () => {}),
  upload: vi.fn(async () => ({ id: 123 })), post: vi.fn(async () => 'created'),
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
  DefaultArtifactClient: class { uploadArtifact = mocks.upload; },
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
  mocks.inputs = { command: 'run', 'working-directory': '.', suite: 'smoke', comment: 'true', 'report-token': 'synthetic-report-token' };
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
    GITHUB_RUN_NUMBER: '10', GITHUB_RUN_ATTEMPT: '1', 'INPUT_REPORT-TOKEN': 'synthetic-report-token',
  })) vi.stubEnv(name, value);
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', architecture);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('reports the native failed verdict with a separate token, never upgrading it to pass', async () => {
  await runAction();
  expect(mocks.setSecret).toHaveBeenCalledWith('synthetic-report-token');
  expect(process.env['INPUT_REPORT-TOKEN']).toBeUndefined();
  expect(mocks.setFailed).toHaveBeenCalledTimes(1);
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('native-verdict-failed'));
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'failed');
  expect(mocks.post).toHaveBeenCalledTimes(1);
  const calls: unknown[][] = mocks.post.mock.calls;
  expect(calls[0]?.[2]).toMatchObject({ outcome: 'failed', code: 'native-verdict-failed' });
  const directory = (await readdir(root)).find((name) => name.startsWith('evals-report-'))!;
  const stored = await readFile(join(root, directory, 'report.json'), 'utf8');
  expect(stored).not.toContain('synthetic-report-token');
  expect(stored).not.toContain('smoke');
});

it('keeps optional networking failure visible without replacing the operation verdict', async () => {
  mocks.post.mockRejectedValue(new ReportingError('github-http-403'));
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledTimes(1);
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('github-http-403'));
  expect(mocks.summaryRaw).toHaveBeenCalledWith(expect.stringContaining('The operation outcome is unchanged'));
});

it('warns for stale reports and uploads raw transcripts only when explicitly requested', async () => {
  mocks.post.mockResolvedValue('stale');
  mocks.inputs['upload-transcripts'] = 'true';
  await runAction();
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('stale-report-skipped'));
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('Perfect redaction is not guaranteed'));
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(mocks.setFailed).toHaveBeenCalledTimes(1);
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
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('comment-context-excluded'));
});

it('reports wrong revision, missing token and disabled commenting without leaking exception text', async () => {
  mocks.revision = 'c'.repeat(40);
  await runAction();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('invalid-input-or-context'));
  mocks.revision = 'a'.repeat(40);
  mocks.inputs['report-token'] = '';
  await runAction();
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('report-token-required'));
  expect(mocks.post).not.toHaveBeenCalled();
  mocks.inputs.comment = 'false';
  await runAction();
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

it('does not convert failure to append an optional warning into a different verdict', async () => {
  mocks.post.mockRejectedValue(new Error('private exception text'));
  mocks.summaryWrite.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('summary unavailable'));
  await runAction();
  expect(mocks.setFailed).toHaveBeenCalledTimes(1);
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('could not be appended'));
  expect(JSON.stringify(mocks.warning.mock.calls)).not.toContain('private exception');
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

it('warns when lint selectors are ignored and keeps the full-project comment identity stable', async () => {
  mocks.inputs.command = 'lint';
  mocks.inputs['eval-paths'] = 'selected.yaml';
  mocks.inputs.tags = 'cost=free';
  mocks.result = { outcome: 'validated', completeness: 'unknown', category: 'none', code: 'native-lint-validated', executed: 0 };
  await runAction();
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('selectors are ignored for lint'));
  const first: unknown[][] = mocks.post.mock.calls;
  const firstContext = first[0]?.[1];
  mocks.inputs.suite = '';
  mocks.inputs['eval-paths'] = '';
  mocks.inputs.tags = '';
  await runAction();
  const calls: unknown[][] = mocks.post.mock.calls;
  expect(calls[1]?.[1]).toEqual(firstContext);
  expect(mocks.setFailed).not.toHaveBeenCalled();
});

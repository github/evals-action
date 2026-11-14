import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { comparisonErrorCode, comparisonFailureMessage, measurementDigest, publishComparison, restoreComparisonSource, runComparisonAction, runComparisonPair } from '../src/comparison-action.js';
import { NativeError } from '../src/native.js';
import { ReportingError } from '../src/github.js';
import { ComparisonError, type ComparisonContext, type ComparisonSelection } from '../src/comparison-context.js';
import type { GitHubClient } from '../src/github.js';
import { sha256, type EngineIdentity } from '../src/tooling.js';
import { inertEnvironment } from '../src/policy.js';

const mocks = vi.hoisted(() => ({
  inputs: {} as Record<string, string>, setOutput: vi.fn<(name: string, value: unknown) => void>(), setFailed: vi.fn(), warning: vi.fn(), acquire: vi.fn(),
  summary: vi.fn(), request: vi.fn(), native: vi.fn(), release: vi.fn(),
}));
vi.mock('@actions/core', () => ({
  getInput: (key: string) => mocks.inputs[key] ?? '', setOutput: mocks.setOutput, setFailed: mocks.setFailed,
  warning: mocks.warning, setSecret: vi.fn(),
  summary: { addRaw: (text: string) => { mocks.summary(text); return { write: async () => {} }; } },
}));
vi.mock('../src/github.js', async (original) => ({
  ...await original<typeof import('../src/github.js')>(),
  githubClient: () => ({ request: mocks.request }),
}));
vi.mock('../src/tooling.js', async (original) => ({
  ...await original<typeof import('../src/tooling.js')>(),
  resolveRelease: mocks.release,
  acquireEngine: mocks.acquire,
}));
vi.mock('../src/native.js', async (original) => ({
  ...await original<typeof import('../src/native.js')>(), runNative: mocks.native,
}));

const sha = (letter: string) => letter.repeat(40);
const context: ComparisonContext = {
  repository: 'o/r', sourceWorkflow: '.github/workflows/notify.yml', sourceRun: '11', sourceAttempt: '3',
  workflowRef: 'o/r/.github/workflows/compare.yml@refs/heads/main',
  run: '99', attempt: '2', runNumber: 8, pullNumber: 7, head: sha('b'), runHead: sha('b'),
  trusted: sha('d'), base: sha('a'), merge: sha('c'),
};
const selection: ComparisonSelection = {
  ...context, changed: ['local/draft'], skills: [{ key: 'local/draft', hasEval: true }],
  include: [{ key: 'local/draft', id: 'skill-abc', directory: 'plugins/local/skills/draft',
    evalPath: 'evals/local/skills/draft/eval.yaml', base: context.base, head: context.head }],
};
const engine: EngineIdentity = { entry: 'synthetic', version: '0.21.0', integrity: '', sha256: '',
  lockSha256: sha('e'), dependencySha256: sha('f') };
const pull = () => ({ state: 'open', head: { sha: context.head, repo: { full_name: context.repository } }, merge_commit_sha: context.merge });
let root: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'evals-comparison-'));
  mocks.inputs = { command: 'context', 'github-token': 'read-token', 'source-workflow': context.sourceWorkflow };
  await writeFile(join(root, 'event.json'), JSON.stringify({ workflow_run: { id: 11, run_attempt: 3, pull_requests: [{ number: 7 }] } }));
  const responses: Record<string, unknown> = {
    '/repos/o/r': { default_branch: 'main' }, '/repos/o/r/actions/runs/11/attempts/3': {
      id: 11, run_attempt: 3, event: 'pull_request', status: 'completed', conclusion: 'success',
      repository: { full_name: 'o/r' }, head_repository: { full_name: 'o/r' }, head_sha: context.runHead,
      workflow_id: 4, pull_requests: [{ number: 7, head: { sha: context.head } }],
    }, '/repos/o/r/actions/workflows/4': { path: context.sourceWorkflow }, '/repos/o/r/pulls/7': pull(),
    [`/repos/o/r/git/commits/${context.merge}`]: { sha: context.merge, parents: [{ sha: context.base }, { sha: context.head }] },
    '/repos/o/r/issues/7/comments?per_page=100&page=1': [],
  };
  mocks.request.mockImplementation(async (method: string, path: string) => {
    if (path === '/graphql') return { data: { viewer: { databaseId: 42, login: 'github-actions[bot]' } } };
    if (method !== 'GET') return { id: 1 };
    if (!(path in responses)) throw new Error('Unexpected test route');
    return responses[path];
  });
  mocks.acquire.mockResolvedValue(engine);
  mocks.release.mockResolvedValue({ version: '0.21.0', integrity: 'synthetic' });
  for (const [key, value] of Object.entries({
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: join(root, 'event.json'), GITHUB_REPOSITORY: 'o/r',
    GITHUB_SHA: context.trusted, GITHUB_WORKFLOW_SHA: context.trusted,
    GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/compare.yml@refs/heads/main',
    GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '2', GITHUB_RUN_NUMBER: '8', RUNNER_TEMP: root, GITHUB_WORKSPACE: root,
  })) vi.stubEnv(key, value);
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('emits authenticated context without acquisition, execution or publication', async () => {
  await runComparisonAction();
  const output = mocks.setOutput.mock.calls.find(([name]) => name === 'context')?.[1];
  if (typeof output !== 'string') throw new Error('Missing context JSON output.');
  expect(JSON.parse(output)).toEqual(context);
  expect(mocks.setOutput).toHaveBeenCalledWith('merge', context.merge);
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
});

it('preserves fixed recovery hints but keeps arbitrary error text private', () => {
  const hint = 'Missing selection.json at the artifact root; use a flat download layout with merge-multiple: true.';
  expect(comparisonFailureMessage(new ComparisonError('comparison-selection-artifact-missing', hint)))
    .toContain(`comparison-selection-artifact-missing. ${hint}`);
  expect(comparisonFailureMessage(new Error('SECRET_RAW_EXCEPTION'))).not.toContain('SECRET');
  expect(comparisonFailureMessage(new ReportingError('github-http-403'))).toContain('github-http-403');
});

it('rejects invalid commands, execution credentials on controls, partial paid retries and platform mismatch before acquisition', async () => {
  for (const input of [
    { command: 'unknown' }, { command: 'context', 'copilot-token': 'billing' },
    { command: 'run', 'producing-attempt': '1' },
    { command: 'run', 'producing-attempt': '' },
  ]) {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    mocks.inputs = { 'source-workflow': context.sourceWorkflow, ...input };
    await expect(runComparisonAction()).rejects.toThrow();
  }
  Object.defineProperty(process, 'platform', { value: 'win32' });
  mocks.inputs = { command: 'run' };
  await expect(runComparisonAction()).rejects.toThrow('linux-x64');
  expect(mocks.acquire).not.toHaveBeenCalled();
});

it('reports only exact trusted selection and producing attempt and posts missing arms as incomplete', async () => {
  await writeFile(join(root, 'selection.json'), JSON.stringify(selection));
  mocks.inputs = { command: 'report', 'source-workflow': context.sourceWorkflow, context: JSON.stringify(context),
    selection: JSON.stringify(selection), 'producing-attempt': '2', 'artifact-directory': root };
  await runComparisonAction();
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'posted');
  expect(mocks.summary).toHaveBeenCalledWith(expect.stringContaining('⚠️ Error → ⚠️ Error'));
  expect(mocks.acquire).not.toHaveBeenCalled();
  mocks.inputs['artifact-directory'] = 'relative';
  await expect(runComparisonAction()).rejects.toThrow('must-be-absolute');
  mocks.inputs['artifact-directory'] = root;
  mocks.inputs.selection = JSON.stringify({ ...selection, include: [] });
  await expect(runComparisonAction()).rejects.toThrow();
  mocks.inputs.context = '{"SECRET_RAW":';
  await expect(runComparisonAction()).rejects.toThrow('malformed-json');
});

it('rejects unknown entries, missing billing credential and mutable Vally versions before acquisition', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  await mkdir(join(root, 'candidate'));
  const baseline = { command: 'run', 'source-workflow': context.sourceWorkflow, context: JSON.stringify(context),
    selection: JSON.stringify(selection), 'producing-attempt': '2', 'comparison-id': 'skill-abc',
    'working-directory': 'candidate', 'vally-version': '0.21.0', 'copilot-token': 'synthetic' };
  for (const change of [{ 'comparison-id': 'not-selected' }, { 'copilot-token': '' }, { 'vally-version': 'latest' }]) {
    mocks.inputs = { ...baseline, ...change };
    await expect(runComparisonAction()).rejects.toThrow();
  }
  mocks.inputs = { ...baseline, context: 'x'.repeat(1024 * 1024 + 1) };
  await expect(runComparisonAction()).rejects.toThrow('too-large');
  expect(mocks.acquire).not.toHaveBeenCalled();
});

it.each(['missing', '..'])('reports invalid working-directory %s with a fixed safe setup code', async (workingDirectory) => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  mocks.inputs = { command: 'run', 'source-workflow': context.sourceWorkflow, context: JSON.stringify(context),
    selection: JSON.stringify(selection), 'producing-attempt': '2', 'comparison-id': 'skill-abc',
    'working-directory': workingDirectory, 'vally-version': '0.21.0', 'copilot-token': 'synthetic' };
  await expect(runComparisonAction()).rejects.toMatchObject({
    code: 'comparison-working-directory-invalid', message: 'comparison-working-directory-invalid',
  });
  expect(mocks.release).not.toHaveBeenCalled();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.native).not.toHaveBeenCalled();
});

it.each(['resolution', 'acquisition'] as const)('reports Vally %s failures without raw exception text', async (phase) => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  await mkdir(join(root, 'candidate'));
  mocks.inputs = { command: 'run', 'source-workflow': context.sourceWorkflow, context: JSON.stringify(context),
    selection: JSON.stringify(selection), 'producing-attempt': '2', 'comparison-id': 'skill-abc',
    'working-directory': 'candidate', 'vally-version': '0.21.0', 'copilot-token': 'synthetic' };
  (phase === 'resolution' ? mocks.release : mocks.acquire).mockRejectedValueOnce(new Error('SECRET_PRIVATE_EXCEPTION'));
  const code = `comparison-vally-${phase}-failed`;
  await expect(runComparisonAction()).rejects.toMatchObject({ code, message: code });
  if (phase === 'resolution') expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.native).not.toHaveBeenCalled();
});

it('publishes bot-owned sticky comments with producing-order protection, current-head checks and size bounds', async () => {
  let comments: unknown[] = [];
  const request = vi.fn<GitHubClient['request']>(async (method, path) => {
    if (path === '/graphql') return { data: { viewer: { databaseId: 42, login: 'comparison-app[bot]' } } };
    if (path.endsWith('/pulls/7')) return pull();
    return method === 'GET' ? comments : { id: 1 };
  });
  const api = { request };
  expect(await publishComparison(selection, 'Before → After', api)).toBe('posted');
  const content = request.mock.calls.at(-1)![2]!.body as string;
  comments = [
    { id: 1, body: content, user: { id: 42, login: 'comparison-app[bot]', type: 'Bot' } },
    { id: 2, body: content.replace('run:8:2', 'run:999:1'), user: { id: 43, login: 'another[bot]', type: 'Bot' } },
  ];
  await publishComparison(selection, 'Updated', api);
  expect(request.mock.calls.at(-1)![0]).toBe('PATCH');
  comments = [{ id: 1, body: content.replace('run:8:2', 'run:9:1'), user: { id: 42, login: 'comparison-app[bot]', type: 'Bot' } }];
  expect(await publishComparison(selection, 'Older', api)).toBe('stale');
  comments = [];
  await expect(publishComparison(selection, 'x'.repeat(60_001), api)).rejects.toThrow('too-large');
  request.mockImplementation(async (_method, path) => {
    if (path === '/graphql') return { data: { viewer: { databaseId: 42, login: 'comparison-app[bot]' } } };
    return path.endsWith('/pulls/7') ? { ...pull(), state: 'closed' } : [];
  });
  await expect(publishComparison(selection, 'No stale write', api)).rejects.toThrow('stale-closed');
  expect(request.mock.calls.at(-1)![1]).toBe('/repos/o/r/pulls/7');
});

it('rejects duplicate bot markers, malformed comment listings and transport failures without posting', async () => {
  const body = `<!-- evals-comparison:o/r/.github/workflows/notify.yml/${sha256(context.workflowRef)} -->`;
  const comment = { id: 1, body, user: { id: 42, login: 'github-actions[bot]', type: 'Bot' } };
  for (const result of [{}, [null], [comment, comment]]) {
    await expect(publishComparison(selection, 'Report', { request: async (_method, path) =>
      path === '/graphql' ? { data: { viewer: { databaseId: 42, login: 'github-actions[bot]' } } } : result })).rejects.toThrow();
  }
});

it.each([
  '', '<!-- run:8:bad -->', '<!-- run:-1:2 -->', 'prefix<!-- run:8:2 -->suffix',
  '<!-- run:0:2 -->', '<!-- run:8:0 -->',
  '<!-- run:9007199254740992:2 -->', '<!-- run:8:9007199254740992 -->',
])('refuses to overwrite a marked report with invalid stored run order: %s', async (tag) => {
  const marker = `<!-- evals-comparison:o/r/.github/workflows/notify.yml/${sha256(context.workflowRef)} -->`;
  const request = vi.fn<GitHubClient['request']>(async (_method, path) => {
    if (path === '/graphql') return { data: { viewer: { databaseId: 42, login: 'comparison-app[bot]' } } };
    if (path.endsWith('/pulls/7')) return pull();
    return [{ id: 1, body: `${marker}\n${tag}\nExisting report`, user: { id: 42 } }];
  });
  await expect(publishComparison(selection, 'Do not replace unknown order', { request }))
    .rejects.toThrow('comparison-invalid-report-order');
  expect(request.mock.calls.some(([method, path]) => method !== 'GET' && path.includes('/issues/'))).toBe(false);
});

it('keeps comment identity and run ordering separate for different trusted workflow refs', async () => {
  let comments: unknown[] = [];
  const request = vi.fn<GitHubClient['request']>(async (method, path) => {
    if (path === '/graphql') return { data: { viewer: { databaseId: 42, login: 'comparison-app[bot]' } } };
    if (path.endsWith('/pulls/7')) return pull();
    return method === 'GET' ? comments : { id: 1 };
  });
  const first = { ...selection, runNumber: 900 };
  await publishComparison(first, 'First workflow', { request });
  const firstBody = request.mock.calls.at(-1)![2]!.body as string;
  comments = [{ id: 1, body: firstBody, user: { id: 42 } }];
  const second = { ...selection, workflowRef: 'o/r/.github/workflows/other.yml@refs/heads/main', run: '100', runNumber: 1 };
  expect(await publishComparison(second, 'Second workflow', { request })).toBe('posted');
  expect(request.mock.calls.at(-1)![0]).toBe('POST');
  const secondBody = request.mock.calls.at(-1)![2]!.body as string;
  expect(secondBody.split('\n')[0]).not.toBe(firstBody.split('\n')[0]);
});

it('refuses non-bot or unavailable publisher identities before listing or writing comments', async () => {
  for (const response of [
    { errors: [{ message: 'not authorized' }] },
    { data: { viewer: { databaseId: 42, login: 'human' } } },
    { data: { viewer: { databaseId: 0, login: 'comparison-app[bot]' } } },
  ]) {
    const request = vi.fn<GitHubClient['request']>(async () => response);
    await expect(publishComparison(selection, 'Report', { request })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('POST', '/graphql', expect.any(Object));
  }
});

it('rejects a regenerated merge in the final live publisher check even when the head is unchanged', async () => {
  const request = vi.fn<GitHubClient['request']>(async (_method, path) => {
    if (path === '/graphql') return { data: { viewer: { databaseId: 42, login: 'comparison-app[bot]' } } };
    if (path.endsWith('/pulls/7')) return { ...pull(), merge_commit_sha: sha('e') };
    return [];
  });
  await expect(publishComparison(selection, 'Do not publish old merge evidence', { request }))
    .rejects.toThrow('comparison-pr-merge-changed');
  expect(request.mock.calls.some(([method, path]) => method !== 'GET' && path.includes('/issues/'))).toBe(false);
});

it('runs After after a failed Before with fresh HOME/TMP, exact native overrides and allowlisted projections', async () => {
  const entry = selection.include[0]!;
  const restore = vi.fn(async () => {});
  const current = vi.fn(async () => {});
  const run = vi.fn<typeof import('../src/native.js').runNative>(async (_inputs, _engine, _cwd, directory) => {
    const file = join(directory, 'native.log');
    await writeFile(file, '');
    return { result: { outcome: 'failed', completeness: 'partial', category: 'evidence', code: 'synthetic-error', nativeRunId: 'native' },
      files: [file], exitCode: 1 };
  });
  expect(await runComparisonPair(context, selection, entry, engine, root, root, 'billing-token', { request: mocks.request },
    { restore, current, run, measurements: async () => 'fixed' })).toBe(false);
  expect(run).toHaveBeenCalledTimes(2);
  expect(restore.mock.calls.map((call) => call.length)).toEqual([4, 4]);
  expect(current).toHaveBeenCalledTimes(2);
  const before = run.mock.calls[0]!, after = run.mock.calls[1]!;
  expect(before[0].overrides).toEqual({ runs: 1, workers: 1, maxRetries: 0 });
  expect(before[0].overrides.model).toBeUndefined();
  expect(before[4].HOME).not.toBe(after[4].HOME);
  expect(before[4].TMPDIR).not.toBe(after[4].TMPDIR);
  expect(before[4].COPILOT_GITHUB_TOKEN).toBe('billing-token');
  expect(before[4]).not.toHaveProperty('GITHUB_TOKEN');
  for (const arm of ['before', 'after']) {
    const data = await readFile(join(root, `skill-abc-${arm}.json`), 'utf8');
    expect(JSON.parse(data)).toMatchObject({ arm, attempt: '2', merge: context.merge, data: { state: 'error' } });
    expect(data).not.toContain('billing-token');
  }
});

it('stale-head guards prevent either native arm and cancellation does not start After', async () => {
  const run = vi.fn<typeof import('../src/native.js').runNative>();
  const deps = { restore: async () => {}, current: async () => { throw new Error('SECRET'); }, run, measurements: async () => 'fixed' };
  await runComparisonPair(context, selection, selection.include[0]!, engine, root, root, 'billing', { request: mocks.request }, deps);
  expect(run).not.toHaveBeenCalled();
  expect(mocks.warning.mock.calls.flat().join(' ')).not.toContain('SECRET');
  const second = await mkdtemp(join(root, 'cancel-'));
  run.mockResolvedValue({ result: { outcome: 'cancelled', completeness: 'partial', category: 'execution', code: 'cancelled' }, files: [] });
  await runComparisonPair(context, selection, selection.include[0]!, engine, root, second, 'billing', { request: mocks.request },
    { ...deps, current: async () => {} });
  expect(run).toHaveBeenCalledTimes(1);
});

it.each(['skipped', 'ungraded'] as const)('rejects native passing arms that contain a %s selected scenario', async (missing) => {
  const trial = {
    type: 'trial-result', runId: 'native', itemId: 'graded', evalName: 'coverage', stimulus: 'graded',
    model: 'mock', variant: 'main', evalFilePath: 'eval.yaml', status: 'success',
    trajectory: { id: 'graded', output: '' },
    gradeResult: { passed: true, score: 1, details: [{ passed: true, score: 1, graderType: 'completed' }] },
  };
  const contents = [
    trial,
    { ...trial, itemId: missing, stimulus: missing, status: missing === 'skipped' ? 'skipped' : 'success', gradeResult: null },
    { type: 'run-summary', runId: 'native', passed: true, hadExecutionErrors: false, evals: [
      { evalFilePath: 'eval.yaml', variant: 'main', model: 'mock', passed: true, scoringApplied: false,
        stimuliRun: missing === 'skipped' ? 1 : 2, stimuliTotal: 2, stimuliSkipped: missing === 'skipped' ? 1 : 0 },
    ] },
  ].map((row) => JSON.stringify(row)).join('\n');
  const run = vi.fn<typeof import('../src/native.js').runNative>(async (_inputs, _engine, _cwd, directory) => {
    const file = join(directory, 'native.log');
    await writeFile(file, contents);
    return { result: { outcome: 'passed', completeness: 'complete', category: 'none', code: 'passed', nativeRunId: 'native' },
      files: [file], exitCode: 0 };
  });
  const passed = await runComparisonPair(context, selection, selection.include[0]!, engine, root, root, '', { request: mocks.request },
    { restore: async () => {}, current: async () => {}, run, measurements: async () => 'fixed' });
  expect(passed).toBe(false);
  expect(run).toHaveBeenCalledTimes(2);
  const arm = JSON.parse(await readFile(join(root, 'skill-abc-after.json'), 'utf8'));
  expect(arm.data.rows[1]).toMatchObject({ state: missing === 'skipped' ? 'not-run' : 'error', passed: false });
  expect(arm.data.rows[0]).toMatchObject({ state: 'graded', passed: true });
});

it('fails oversized projections explicitly, uploads bounded error state and still attempts After', async () => {
  const rows = Array.from({ length: 3000 }, (_, index) => ({
    type: 'trial-result', runId: 'native', itemId: String(index), evalName: 'size-control', stimulus: `case-${index}`,
    model: 'mock', variant: 'main', evalFilePath: 'eval.yaml', status: 'success',
    trajectory: { id: String(index), output: '' },
    gradeResult: { passed: true, score: 1, details: [{ passed: true, score: 1, graderType: 'completed', configuredName: 'n'.repeat(256) }] },
  }));
  const contents = [...rows, {
    type: 'run-summary', runId: 'native', passed: true, hadExecutionErrors: false,
    evals: [{ evalFilePath: 'eval.yaml', variant: 'main', model: 'mock', scoringApplied: false,
      passed: true, stimuliRun: rows.length, stimuliTotal: rows.length }],
  }].map((row) => JSON.stringify(row)).join('\n');
  const run = vi.fn<typeof import('../src/native.js').runNative>(async (_inputs, _engine, _cwd, directory) => {
    const file = join(directory, 'native.log');
    await writeFile(file, contents);
    return { result: { outcome: 'passed', completeness: 'complete', category: 'none', code: 'passed', nativeRunId: 'native' },
      files: [file], exitCode: 0 };
  });
  const passed = await runComparisonPair(context, selection, selection.include[0]!, engine, root, root, '', { request: mocks.request },
    { restore: async () => {}, current: async () => {}, run, measurements: async () => 'fixed' });
  expect(passed).toBe(false);
  expect(run).toHaveBeenCalledTimes(2);
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('comparison-projection-too-large'));
  expect(JSON.parse(await readFile(join(root, 'skill-abc-before.json'), 'utf8')).data).toEqual({ state: 'error', nativeOutcome: 'passed', rows: [] });
});

it('preserves known API and native failure codes without exposing unknown exception text', async () => {
  for (const error of [new ReportingError('github-http-403'), new NativeError('native-version-mismatch')]) {
    const directory = await mkdtemp(join(root, 'failure-'));
    await runComparisonPair(context, selection, selection.include[0]!, engine, root, directory, '', { request: mocks.request },
      { restore: async () => {}, current: async () => { throw error; }, run: mocks.native, measurements: async () => 'fixed' });
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining(error.code));
    expect(comparisonErrorCode(error, 'comparison-operation-failed')).toBe(error.code);
  }
  expect(comparisonErrorCode(new ReportingError('reporting-bot-token-required'), 'fallback')).toBe('reporting-bot-token-required');
  expect(comparisonErrorCode(Object.assign(new Error('SECRET'), { code: 'SECRET' }), 'comparison-operation-failed'))
    .toBe('comparison-operation-failed');
});

it('preserves the observed native error when empty stdout has no projected native outcome', async () => {
  const run = vi.fn<typeof import('../src/native.js').runNative>(async (_inputs, _engine, _cwd, directory) => {
    const file = join(directory, 'empty.stdout');
    await writeFile(file, '');
    return { result: { outcome: 'error', completeness: 'partial', category: 'evidence',
      code: 'native-run-summary-missing', nativeRunId: 'native' }, files: [file], exitCode: 1 };
  });
  expect(await runComparisonPair(context, selection, selection.include[0]!, engine, root, root, '', { request: mocks.request },
    { restore: async () => {}, current: async () => {}, run, measurements: async () => 'fixed' })).toBe(false);
  const data = JSON.parse(await readFile(join(root, 'skill-abc-after.json'), 'utf8')).data;
  expect(data).toEqual({ state: 'error', rows: [], nativeOutcome: 'error' });
});

it('does not persist execution credentials emitted in candidate-controlled native labels', async () => {
  const token = 'opaque-execution-credential';
  const run = vi.fn<typeof import('../src/native.js').runNative>(async (_inputs, _engine, _cwd, directory) => {
    const file = join(directory, 'native.log');
    await writeFile(file, [
      { type: 'trial-result', runId: 'native', itemId: 'case', evalName: 'example', stimulus: 'case',
        model: 'mock', variant: 'main', evalFilePath: 'eval.yaml', status: 'success',
        trajectory: { id: 'case', output: '' }, gradeResult: { passed: true, score: 1,
          details: [{ graderType: 'completed', configuredName: token, passed: true, score: 1 }] } },
      { type: 'run-summary', runId: 'native', passed: true, hadExecutionErrors: false,
        evals: [{ evalFilePath: 'eval.yaml', variant: 'main', model: 'mock', scoringApplied: false,
          passed: true, stimuliRun: 1, stimuliTotal: 1 }] },
    ].map((row) => JSON.stringify(row)).join('\n'));
    return { result: { outcome: 'passed', completeness: 'complete', category: 'none', code: 'passed', nativeRunId: 'native' },
      files: [file], exitCode: 0 };
  });
  expect(await runComparisonPair(context, selection, selection.include[0]!, engine, root, root, token, { request: mocks.request },
    { restore: async () => {}, current: async () => {}, run, measurements: async () => 'fixed' })).toBe(false);
  for (const arm of ['before', 'after']) {
    const saved = await readFile(join(root, `skill-abc-${arm}.json`), 'utf8');
    expect(saved).not.toContain(token);
    expect(JSON.parse(saved).data).toMatchObject({ state: 'error', rows: [] });
  }
  expect(mocks.warning.mock.calls.flat().join(' ')).not.toContain(token);
});

it.each(['before', 'after'] as const)('rejects a passing %s arm that changes actual measurement bytes', async (mutatingArm) => {
  const cwd = join(root, 'candidate'), output = join(root, 'output');
  await mkdir(join(cwd, 'skills', 'draft'), { recursive: true });
  await mkdir(output);
  const fixture = join(cwd, 'fixture.txt');
  await writeFile(fixture, 'original');
  let calls = 0;
  const run = vi.fn<typeof import('../src/native.js').runNative>(async (_inputs, _engine, _cwd, directory) => {
    const arm = calls++ === 0 ? 'before' : 'after';
    if (arm === mutatingArm) await writeFile(fixture, 'changed');
    const file = join(directory, 'native.log');
    await writeFile(file, [
      { type: 'trial-result', runId: 'native', itemId: 'case', evalName: 'measurement', stimulus: 'case',
        model: 'mock', variant: 'main', evalFilePath: 'eval.yaml', status: 'success',
        trajectory: { id: 'case', output: '' },
        gradeResult: { passed: true, score: 1, details: [{ passed: true, score: 1, graderType: 'completed' }] } },
      { type: 'run-summary', runId: 'native', passed: true, hadExecutionErrors: false,
        evals: [{ evalFilePath: 'eval.yaml', variant: 'main', model: 'mock', scoringApplied: false,
          passed: true, stimuliRun: 1, stimuliTotal: 1 }] },
    ].map((row) => JSON.stringify(row)).join('\n'));
    return { result: { outcome: 'passed', completeness: 'complete', category: 'none', code: 'passed', nativeRunId: 'native' },
      files: [file], exitCode: 0 };
  });
  const entry = { ...selection.include[0]!, directory: 'skills/draft' };
  expect(await runComparisonPair(context, selection, entry, engine, cwd, output, '', { request: mocks.request },
    { restore: async () => {}, current: async () => {}, run, measurements: measurementDigest })).toBe(false);
  expect(run).toHaveBeenCalledTimes(mutatingArm === 'before' ? 1 : 2);
  const arm = JSON.parse(await readFile(join(output, `skill-abc-${mutatingArm}.json`), 'utf8'));
  expect(arm.data).toEqual({ state: 'error', nativeOutcome: 'passed', rows: [] });
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('comparison-measurement-bytes-changed'));
  if (mutatingArm === 'after') {
    const before = JSON.parse(await readFile(join(output, 'skill-abc-before.json'), 'utf8'));
    expect(before.data).toMatchObject({ state: 'complete', nativeOutcome: 'passed', rows: [{ state: 'graded', passed: true }] });
  }
});

it('measures other resolved file symlinks and rejects dangling or looping targets with a safe code', async ({ skip }) => {
  const cwd = join(root, 'candidate'), skill = join(cwd, 'skills', 'draft');
  await mkdir(skill, { recursive: true });
  const source = join(skill, 'SKILL.md');
  await writeFile(source, 'before');
  const unlinked = await measurementDigest(cwd, 'skills/draft');
  await writeFile(source, 'after');
  expect(await measurementDigest(cwd, 'skills/draft')).toBe(unlinked);
  await writeFile(source, 'before');
  const measurement = join(root, 'measurement.txt');
  await writeFile(measurement, 'original fixture');
  try { await symlink(measurement, join(cwd, 'fixture.txt'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return skip('Windows file symlink creation requires an unavailable privilege; Linux qualification remains required.');
    }
    throw error;
  }
  const before = await measurementDigest(cwd, 'skills/draft');
  await writeFile(measurement, 'changed fixture!');
  expect(await measurementDigest(cwd, 'skills/draft')).not.toBe(before);
  const fixture = join(cwd, 'fixture.txt');
  await rm(fixture);
  await symlink(join(cwd, 'missing.txt'), fixture, 'file');
  await expect(measurementDigest(cwd, 'skills/draft')).rejects.toThrow('comparison-unsupported-measurement-symlink');
  await rm(fixture);
  await symlink(fixture, fixture, 'file');
  await expect(measurementDigest(cwd, 'skills/draft')).rejects.toThrow('comparison-unsupported-measurement-symlink');
});

it.each([true, false])('rejects a tracked alias into the skill before native execution (alias: %s)', async (alias) => {
  const cwd = join(root, 'candidate'), output = join(root, 'output');
  await mkdir(join(cwd, 'skills', 'draft'), { recursive: true });
  await mkdir(join(cwd, 'docs'));
  await mkdir(output);
  const source = join(cwd, 'skills', 'draft', 'SKILL.md');
  await writeFile(source, 'before');
  await writeFile(join(cwd, 'eval.yaml'), 'native configuration fixture');
  await writeFile(join(cwd, 'docs', 'readme.md'), 'fixed measurement context');
  if (alias) await symlink(source, join(cwd, 'docs', 'draft.md'), 'file');
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: inertEnvironment(process.env),
  }).trim();
  git('init', '-q'); git('config', 'core.symlinks', 'true');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'skill');
  await writeFile(source, 'after');
  git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'merge', base);
  git('merge', '--no-ff', '-qm', 'merge', 'skill');
  const ctx = { ...context, base, head, runHead: head, merge: git('rev-parse', 'HEAD') };
  const entry = { ...selection.include[0]!, directory: 'skills/draft', evalPath: 'eval.yaml', base, head };
  if (alias) expect(git('ls-files', '--stage', '--', 'docs/draft.md')).toMatch(/^120000 /);
  const observed: string[] = [];
  const run = vi.fn<typeof import('../src/native.js').runNative>(async () => {
    observed.push(await readFile(source, 'utf8'));
    return { result: { outcome: 'failed', completeness: 'complete', category: 'none', code: 'fixture-failure' }, files: [] };
  });
  await runComparisonPair(ctx, { ...selection, ...ctx, include: [entry] }, entry, engine, cwd, output, '', { request: mocks.request },
    { restore: restoreComparisonSource, current: async () => {}, run, measurements: measurementDigest });
  expect(observed).toEqual(alias ? [] : ['before', 'after']);
  expect(run).toHaveBeenCalledTimes(alias ? 0 : 2);
  if (alias) expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('comparison-skill-measurement-alias-unsupported'));
}, 30_000);

it('rejects directory symlinks rather than ignoring their resolved measurement tree', async () => {
  const cwd = join(root, 'candidate'), skill = join(cwd, 'skills', 'draft');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), 'before');
  await symlink(skill, join(cwd, 'fixture-directory'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(measurementDigest(cwd, 'skills/draft')).rejects.toThrow('comparison-unsupported-measurement-symlink');
});

it('qualifies a caller-mapped non-marketplace layout with native Before/After and source-integrity guards', async () => {
  const cwd = join(root, 'candidate');
  await mkdir(join(cwd, 'skills', 'draft'), { recursive: true });
  await mkdir(join(cwd, 'evals'), { recursive: true });
  await writeFile(join(cwd, 'skills', 'draft', 'SKILL.md'), 'before');
  await writeFile(join(cwd, 'skills', 'draft', 'café.md'), 'unicode source');
  await writeFile(join(cwd, 'skills', 'draft', 'removed.md'), 'removed by head');
  await writeFile(join(cwd, 'skills', 'draft', 'old.md'), 'renamed by head');
  await writeFile(join(cwd, '.gitignore'), 'skills/draft/*.cache\nfixtures/\n');
  await mkdir(join(cwd, 'fixtures'));
  await writeFile(join(cwd, 'fixtures', 'measurement.txt'), 'original\nbytes\n');
  await writeFile(join(cwd, '.gitattributes'), 'fixtures/*.txt text eol=lf\n');
  await writeFile(join(cwd, '.gitmodules'), '[submodule "fixture-module"]\npath = fixture-module\nurl = ../fixture-module\nignore = all\n');
  await writeFile(join(cwd, '.vally.yaml'), 'plugins:\n  grader: [./source-grader.mjs]\n');
  await writeFile(join(cwd, 'evals', 'eval.yaml'), [
    'name: source-comparison', 'type: capability', 'defaults:', '  executor: mock', '  model: mock-only',
    'stimuli:', '  - name: source', '    prompt: model-free-control', '    graders:', '      - type: skill-source',
  ].join('\n'));
  await writeFile(join(cwd, 'source-grader.mjs'), [
    "import { readFile } from 'node:fs/promises';",
    'export function registerGraders(registry) { registry.register({',
    "metadata: { name: 'skill-source', description: 'Deterministic source control', behavior: {}, costProfile: 'free',",
    "determinism: 'static', reference: 'reference-free', temporalScope: 'trajectory-level' },",
    "async grade() { const passed = (await readFile(new URL('./skills/draft/SKILL.md', import.meta.url), 'utf8')) === 'after';",
    'return { passed, score: passed ? 1 : 0 }; } }); }',
  ].join('\n'));
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: inertEnvironment(process.env),
  }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('add', '-f', 'fixtures/measurement.txt'); git('commit', '-qm', 'base');
  const gitlink = git('rev-parse', 'HEAD');
  await mkdir(join(cwd, 'fixture-module'));
  git('update-index', '--add', '--cacheinfo', `160000,${gitlink},fixture-module`);
  git('commit', '-qm', 'uninitialized gitlink');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'skill');
  await writeFile(join(cwd, 'skills', 'draft', 'SKILL.md'), 'after');
  await writeFile(join(cwd, 'skills', 'draft', 'added.md'), 'added by head');
  git('rm', '-q', '--', 'skills/draft/removed.md');
  git('mv', '--', 'skills/draft/old.md', 'skills/draft/new.md');
  git('add', '--', 'skills/draft/added.md');
  git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'merge', base);
  await writeFile(join(cwd, 'neighbor'), 'merge context');
  git('add', '.'); git('commit', '-qm', 'base advance');
  const firstParent = git('rev-parse', 'HEAD');
  git('merge', '--no-ff', '-qm', 'merge', 'skill');
  const merge = git('rev-parse', 'HEAD');
  const ctx = { ...context, merge, head, runHead: head, base: firstParent };
  const entry = { ...selection.include[0]!, directory: 'skills/draft', evalPath: 'evals/eval.yaml', base: firstParent, head };
  await restoreComparisonSource(cwd, ctx, entry, firstParent);
  expect(await readFile(join(cwd, entry.directory, 'SKILL.md'), 'utf8')).toBe('before');
  expect(await readFile(join(cwd, entry.directory, 'removed.md'), 'utf8')).toBe('removed by head');
  expect(await readFile(join(cwd, entry.directory, 'old.md'), 'utf8')).toBe('renamed by head');
  await expect(readFile(join(cwd, entry.directory, 'added.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, entry.directory, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(cwd, 'neighbor'), 'utf8')).toBe('merge context');
  await restoreComparisonSource(cwd, ctx, entry, head);
  expect(await readFile(join(cwd, entry.directory, 'SKILL.md'), 'utf8')).toBe('after');
  expect(await readFile(join(cwd, entry.directory, 'added.md'), 'utf8')).toBe('added by head');
  expect(await readFile(join(cwd, entry.directory, 'new.md'), 'utf8')).toBe('renamed by head');
  await expect(readFile(join(cwd, entry.directory, 'removed.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, entry.directory, 'old.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  const shallow = join(cwd, '.git', 'shallow');
  await writeFile(shallow, `${merge}\n`);
  await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('comparison-checkout-revision-mismatch');
  await rm(shallow);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    git('update-index', `--${flag}`, '--', entry.evalPath);
    await writeFile(join(cwd, entry.evalPath), 'hidden measurement change');
    expect(git('diff', 'HEAD', '--', entry.evalPath)).toBe('');
    await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('comparison-hidden-index-flags');
    git('update-index', `--no-${flag}`, '--', entry.evalPath);
    git('restore', '--', entry.evalPath);
  }
  await expect(restoreComparisonSource(cwd, { ...ctx, merge: context.merge }, entry, head)).rejects.toThrow('revision-mismatch');
  await writeFile(join(cwd, 'neighbor'), 'candidate mutation');
  await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('measurement-files-changed');
  git('restore', '--', 'neighbor');
  await writeFile(join(cwd, 'unexpected'), 'untracked candidate mutation');
  await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('measurement-files-changed');
  await rm(join(cwd, 'unexpected'));
  const ignoredSkill = join(cwd, 'skills', 'draft', 'before.cache');
  await writeFile(ignoredSkill, 'untracked Before skill state');
  await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('measurement-files-changed');
  expect(await readFile(ignoredSkill, 'utf8')).toBe('untracked Before skill state');
  await rm(ignoredSkill);
  await mkdir(join(cwd, 'fixtures'), { recursive: true });
  const ignoredFixture = join(cwd, 'fixtures', 'before.cache');
  await writeFile(ignoredFixture, 'untracked Before fixture state');
  await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('measurement-files-changed');
  await rm(ignoredFixture);
  if (process.platform !== 'win32') {
    const whitespaceFile = join(cwd, 'fixtures', '   ');
    await writeFile(whitespaceFile, 'ignored whitespace-only filename');
    await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('measurement-files-changed');
    await rm(whitespaceFile);
  }
  await symlink(join(cwd, 'evals'), join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(restoreComparisonSource(cwd, ctx, { ...entry, evalPath: 'linked/eval.yaml' }, head)).rejects.toThrow('symlinked');
  await rm(join(cwd, 'linked'));

  const module = join(cwd, 'fixture-module');
  const moduleGit = (...args: string[]) => execFileSync('git', ['-C', module, ...args], { encoding: 'utf8' }).trim();
  await mkdir(module, { recursive: true });
  moduleGit('init', '-q'); moduleGit('config', 'user.name', 'Fixture'); moduleGit('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(module, 'fixture.txt'), 'original');
  moduleGit('add', '.'); moduleGit('commit', '-qm', 'module fixture');
  await writeFile(join(module, 'fixture.txt'), 'hidden submodule change');
  expect(git('diff', 'HEAD', '--', 'fixture-module')).toBe('');
  expect(git('ls-files', '--others')).toBe('');
  await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('initialized-submodule-unsupported');
  await rm(module, { recursive: true, force: true });
  await mkdir(module);

  const measurement = join(cwd, 'fixtures', 'measurement.txt');
  const byteMutation = vi.fn<typeof import('../src/native.js').runNative>(async () => {
    await writeFile(measurement, 'original\r\nbytes\r\n');
    expect(git('diff', 'HEAD', '--', 'fixtures/measurement.txt')).toBe('');
    return { result: { outcome: 'failed', completeness: 'complete', category: 'none', code: 'fixture-failure' }, files: [] };
  });
  const byteOutput = await mkdtemp(join(root, 'byte-drift-'));
  await runComparisonPair(ctx, { ...selection, ...ctx, include: [entry] }, entry, engine, cwd, byteOutput, '', { request: mocks.request },
    { restore: restoreComparisonSource, current: async () => {}, run: byteMutation, measurements: measurementDigest });
  expect(byteMutation).toHaveBeenCalledTimes(1);
  expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('comparison-measurement-bytes-changed'));
  await writeFile(measurement, 'original\nbytes\n');

  const emptyCache = join(cwd, 'skills', 'draft', 'cache');
  await mkdir(emptyCache);
  expect(git('ls-files', '--others', '-z')).toBe('');
  await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('comparison-measurement-files-changed');
  await rm(emptyCache, { recursive: true, force: true });

  git('replace', head, base);
  expect(git('show', `${head}:skills/draft/SKILL.md`)).toBe('before');
  await restoreComparisonSource(cwd, ctx, entry, head);
  expect(await readFile(join(cwd, 'skills', 'draft', 'SKILL.md'), 'utf8')).toBe('after');
  git('replace', '-d', head);

  const shadow = join(root, 'shadow');
  await mkdir(join(shadow, 'skills', 'draft'), { recursive: true });
  await writeFile(join(shadow, 'skills', 'draft', 'SKILL.md'), 'after');
  await restoreComparisonSource(cwd, ctx, entry, firstParent);
  git('config', 'core.worktree', shadow);
  await restoreComparisonSource(cwd, ctx, entry, head);
  expect(await readFile(join(cwd, 'skills', 'draft', 'SKILL.md'), 'utf8')).toBe('after');
  git('config', '--unset', 'core.worktree');

  const attributes = join(cwd, '.git', 'info', 'attributes');
  for (const driver of ['unset', 'unspecified']) {
    await writeFile(attributes, `skills/draft/SKILL.md filter=${driver}\n`);
    git('config', `filter.${driver}.smudge`, 'echo FILTERED_SOURCE');
    git('config', `filter.${driver}.clean`, 'git --no-replace-objects show HEAD:skills/draft/SKILL.md');
    git('config', `filter.${driver}.required`, 'true');
    await rm(join(cwd, 'skills', 'draft', 'SKILL.md'));
    git('checkout-index', '--force', '--', 'skills/draft/SKILL.md');
    expect((await readFile(join(cwd, 'skills', 'draft', 'SKILL.md'), 'utf8')).trim()).toBe('FILTERED_SOURCE');
    expect(git('check-attr', 'filter', '--', 'skills/draft/SKILL.md')).toContain(`filter: ${driver}`);
    expect(git('diff', '--exit-code', head, '--', 'skills/draft/SKILL.md')).toBe('');
    await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('comparison-git-filters-unsupported');
    git('config', '--remove-section', `filter.${driver}`);
  }
  await rm(attributes);
  await restoreComparisonSource(cwd, ctx, entry, head);
  await writeFile(attributes, 'skills/draft/SKILL.md filter=shadow\n');
  git('config', 'filter.shadow.smudge', 'echo FILTERED_SOURCE');
  git('config', 'filter.shadow.clean', 'git --no-replace-objects show HEAD:skills/draft/SKILL.md');
  git('config', 'filter.shadow.required', 'true');
  expect(git('check-attr', 'filter', '--', 'skills/draft/SKILL.md')).toContain('filter: shadow');
  await rm(join(cwd, 'skills', 'draft', 'SKILL.md'));
  git('checkout-index', '--force', '--', 'skills/draft/SKILL.md');
  expect((await readFile(join(cwd, 'skills', 'draft', 'SKILL.md'), 'utf8')).trim()).toBe('FILTERED_SOURCE');
  expect(git('diff', '--exit-code', head, '--', 'skills/draft/SKILL.md')).toBe('');
  await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('comparison-git-filters-unsupported');
  await writeFile(attributes, 'fixtures/measurement.txt filter=shadow\n');
  await expect(restoreComparisonSource(cwd, ctx, entry, head)).rejects.toThrow('comparison-git-filters-unsupported');
  await rm(attributes);
  git('config', '--remove-section', 'filter.shadow');
  await restoreComparisonSource(cwd, ctx, entry, head);
  expect(await readFile(join(cwd, 'skills', 'draft', 'SKILL.md'), 'utf8')).toBe('after');

  const hook = join(cwd, '.git', 'hooks', 'post-index-change');
  const monitor = join(cwd, '.git', 'hooks', 'comparison-fsmonitor');
  const hookMarker = join(cwd, '.git', 'hook-ran'), monitorMarker = join(cwd, '.git', 'fsmonitor-ran');
  await writeFile(hook, '#!/bin/sh\nprintf hook > .git/hook-ran\n', { mode: 0o700 });
  await writeFile(monitor, '#!/bin/sh\nprintf monitor > .git/fsmonitor-ran\nprintf "token\\\\000"\n', { mode: 0o700 });
  git('read-tree', merge);
  expect(await readFile(hookMarker, 'utf8')).toBe('hook');
  git('config', 'core.fsmonitor', '.git/hooks/comparison-fsmonitor');
  git('config', 'core.fsmonitorHookVersion', '2');
  git('status', '--porcelain');
  expect(await readFile(monitorMarker, 'utf8')).toBe('monitor');
  await rm(hookMarker, { force: true });
  await rm(monitorMarker);
  await restoreComparisonSource(cwd, ctx, entry, firstParent);
  await restoreComparisonSource(cwd, ctx, entry, head);
  expect(await readFile(join(cwd, 'skills', 'draft', 'SKILL.md'), 'utf8')).toBe('after');
  await expect(readFile(hookMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(monitorMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(hook);
  await rm(monitor);
  git('config', '--unset', 'core.fsmonitor');
  git('config', '--unset', 'core.fsmonitorHookVersion');

  const actualNative = await vi.importActual<typeof import('../src/native.js')>('../src/native.js');
  const tooling = await vi.importActual<typeof import('../src/tooling.js')>('../src/tooling.js');
  const manifest = createRequire(import.meta.url).resolve('@microsoft/vally-cli/package.json');
  const nativeEntry = join(dirname(manifest), 'dist', 'index.js');
  mocks.acquire.mockResolvedValue({ ...engine, entry: nativeEntry, sha256: tooling.sha256(await readFile(nativeEntry)) });
  mocks.native.mockImplementation(actualNative.runNative);
  const selected = { ...selection, ...ctx, include: [entry] };
  const priorRequest = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (method: string, path: string) => {
    if (path === '/repos/o/r/pulls/7') return { ...pull(), head: { sha: head, repo: { full_name: 'o/r' } }, merge_commit_sha: merge };
    if (path === '/repos/o/r/actions/runs/11/attempts/3') return {
      id: 11, run_attempt: 3, event: 'pull_request', status: 'completed', conclusion: 'success',
      repository: { full_name: 'o/r' }, head_repository: { full_name: 'o/r' }, head_sha: ctx.runHead,
      workflow_id: 4, pull_requests: [{ number: 7, head: { sha: head } }],
    };
    if (path === `/repos/o/r/git/commits/${merge}`) return { sha: merge, parents: [{ sha: firstParent }, { sha: head }] };
    return priorRequest(method, path);
  });
  mocks.inputs = { command: 'run', 'source-workflow': context.sourceWorkflow, context: JSON.stringify(ctx),
    selection: JSON.stringify(selected), 'producing-attempt': '2', 'comparison-id': entry.id,
    'working-directory': 'candidate', 'vally-version': '0.21.0', 'copilot-token': 'synthetic-unused' };
  // The host is Windows; execution support is Linux-only, but this model-free control exercises
  // the platform-independent adapter with the real mock executor and deterministic grader.
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  await runComparisonAction();
  expect(mocks.native).toHaveBeenCalledTimes(2);
  expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('did not pass'));
  expect(mocks.setOutput).toHaveBeenCalledWith('outcome', 'failed');
  const projected = new Map(mocks.setOutput.mock.calls);
  const before = JSON.parse(await readFile(projected.get('before-path') as string, 'utf8'));
  const after = JSON.parse(await readFile(projected.get('after-path') as string, 'utf8'));
  expect(before.data).toMatchObject({ state: 'complete', rows: [{ state: 'graded', passed: false }] });
  expect(after.data).toMatchObject({ state: 'complete', rows: [{ state: 'graded', passed: true }] });
  expect(await readFile(join(cwd, 'skills/draft/SKILL.md'), 'utf8')).toBe('after');
  expect(mocks.summary).toHaveBeenCalledWith(expect.stringContaining('dependency lock SHA-256'));
}, 120_000);

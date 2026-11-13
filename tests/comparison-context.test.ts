import { expect, it, vi } from 'vitest';
import { assertContext, authenticateComparison, validateComparisonSelection } from '../src/comparison-context.js';
import type { GitHubClient } from '../src/github.js';

const sha = (letter: string) => letter.repeat(40);
export function fixture() {
  const env = {
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: sha('d'),
    GITHUB_WORKFLOW_SHA: sha('d'), GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/compare.yml@refs/heads/main',
    GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '2', GITHUB_RUN_NUMBER: '8',
  };
  const source = { id: 11, run_attempt: 3, pull_requests: [{ number: 7 }] };
  const run = {
    ...source, event: 'pull_request', status: 'completed', conclusion: 'success',
    repository: { full_name: 'o/r' }, head_repository: { full_name: 'o/r' }, head_sha: sha('b'),
    workflow_id: 4, pull_requests: [{ number: 7, head: { sha: sha('b') } }],
  };
  const pull = { state: 'open', head: { sha: sha('b'), repo: { full_name: 'o/r' } }, merge_commit_sha: sha('c'), base: { sha: sha('e') } };
  const commit = { sha: sha('c'), parents: [{ sha: sha('a') }, { sha: sha('b') }] };
  const responses: Record<string, unknown> = {
    '/repos/o/r': { default_branch: 'main' }, '/repos/o/r/actions/runs/11/attempts/3': run,
    '/repos/o/r/actions/workflows/4': { path: '.github/workflows/notify.yml' },
    '/repos/o/r/pulls/7': pull, [`/repos/o/r/git/commits/${sha('c')}`]: commit,
  };
  const request = vi.fn<GitHubClient['request']>(async (_method, path) => {
    if (!(path in responses)) throw new Error(`Unexpected test route ${path}`);
    return responses[path];
  });
  const context = {
    repository: 'o/r', sourceWorkflow: '.github/workflows/notify.yml', sourceRun: '11', sourceAttempt: '3',
    workflowRef: env.GITHUB_WORKFLOW_REF,
    run: '99', attempt: '2', runNumber: 8, pullNumber: 7, head: sha('b'), runHead: sha('b'),
    trusted: sha('d'), base: sha('a'), merge: sha('c'),
  };
  const selection = {
    ...context, changed: ['local/draft'], skills: [{ key: 'local/draft', hasEval: true }],
    include: [{ key: 'local/draft', id: 'skill-abc', directory: 'plugins/local/skills/draft',
      evalPath: 'evals/local/skills/draft/eval.yaml', base: context.base, head: context.head }],
  };
  return { env, source, run, pull, commit, responses, api: { request }, context, selection };
}

it('authenticates exact source/producing attempts and derives base from current merge parents rather than PR base metadata', async () => {
  const f = fixture();
  expect(await authenticateComparison({ workflow_run: f.source }, f.context.sourceWorkflow, f.api, f.env)).toEqual(f.context);
  expect(await authenticateComparison({ workflow_run: f.source }, f.context.sourceWorkflow, f.api, f.env, '1'))
    .toEqual({ ...f.context, attempt: '1' });
  expect(f.api.request).toHaveBeenCalledWith('GET', '/repos/o/r/actions/runs/11/attempts/3');
  expect(f.context.base).not.toBe(f.pull.base.sha);
  assertContext(f.context, f.context);
  expect(() => assertContext(f.context, { ...f.context, sourceAttempt: '2' })).toThrow('context-mismatch');
});

it.each([
  { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_REPOSITORY: 'invalid' },
  { GITHUB_SHA: 'bad' }, { GITHUB_WORKFLOW_SHA: sha('e') }, { GITHUB_RUN_ID: '0' },
  { GITHUB_RUN_ATTEMPT: '2.1' }, { GITHUB_RUN_NUMBER: '' },
  { GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/compare.yml@refs/pull/7/merge' },
])('rejects unsupported or untrusted workflow identity %j', async (change) => {
  const f = fixture();
  await expect(authenticateComparison({ workflow_run: f.source }, f.context.sourceWorkflow, f.api, { ...f.env, ...change })).rejects.toThrow();
});

it('rejects invalid source workflow selectors and future producing attempts', async () => {
  const f = fixture();
  for (const workflow of ['', '../notify.yml', '.github/workflows/notify.yml@main']) {
    await expect(authenticateComparison({ workflow_run: f.source }, workflow, f.api, f.env)).rejects.toThrow('comparison-invalid-source-workflow');
  }
  for (const attempt of ['0', '3', 'NaN']) {
    await expect(authenticateComparison({ workflow_run: f.source }, f.context.sourceWorkflow, f.api, f.env, attempt)).rejects.toThrow();
  }
  await expect(authenticateComparison({ workflow_run: { ...f.source, id: -1 } }, f.context.sourceWorkflow, f.api, f.env)).rejects.toThrow();
});

it('authenticates dotted source workflow filenames against the exact API path', async () => {
  const f = fixture();
  const path = '.github/workflows/skill-evals.pr.yml';
  f.responses['/repos/o/r/actions/workflows/4'] = { path };
  expect(await authenticateComparison({ workflow_run: f.source }, path, f.api, f.env)).toEqual({ ...f.context, sourceWorkflow: path });
  await expect(authenticateComparison({ workflow_run: f.source }, '.github/workflows/skill-evals.yml', f.api, f.env))
    .rejects.toThrow('source-workflow-mismatch');
});

it('rejects stale source heads even when the API associates the run with the current PR head', async () => {
  const f = fixture();
  f.run.head_sha = sha('e');
  await expect(authenticateComparison({ workflow_run: f.source }, f.context.sourceWorkflow, f.api, f.env))
    .rejects.toThrow('comparison-source-head-mismatch');
  expect(f.api.request).not.toHaveBeenCalledWith('GET', '/repos/o/r/pulls/7');
});

it.each([
  { id: 12 }, { run_attempt: 2 }, { event: 'push' }, { status: 'in_progress' }, { conclusion: 'cancelled' },
  { repository: { full_name: 'other/repo' } }, { head_repository: { full_name: 'fork/repo' } },
  { head_sha: 'bad' }, { workflow_id: 0 }, { pull_requests: [] },
  { pull_requests: [{ number: 0, head: { sha: sha('b') } }] },
  { pull_requests: [{ number: 7, head: { sha: 'bad' } }] },
])('rejects unauthenticated producer metadata %j', async (change) => {
  const f = fixture();
  Object.assign(f.run, change);
  await expect(authenticateComparison({ workflow_run: f.source }, f.context.sourceWorkflow, f.api, f.env)).rejects.toThrow();
});

it('rejects wrong workflow paths, PR associations, stale/fork/closed heads and unverifiable merges', async () => {
  for (const target of ['workflow', 'association', 'closed', 'stale', 'fork', 'merge', 'parents', 'parent-head']) {
    const f = fixture();
    if (target === 'workflow') f.responses['/repos/o/r/actions/workflows/4'] = { path: '.github/workflows/other.yml' };
    if (target === 'association') f.source.pull_requests = [{ number: 8 }];
    if (target === 'closed') f.pull.state = 'closed';
    if (target === 'stale') f.pull.head.sha = sha('e');
    if (target === 'fork') f.pull.head.repo.full_name = 'fork/repo';
    if (target === 'merge') f.pull.merge_commit_sha = '';
    if (target === 'parents') f.commit.parents.pop();
    if (target === 'parent-head') f.commit.parents[1]!.sha = sha('e');
    await expect(authenticateComparison({ workflow_run: f.source }, f.context.sourceWorkflow, f.api, f.env)).rejects.toThrow();
  }
});

it('accepts only exact source-bound generic selections with unique contained paths and coverage', () => {
  const f = fixture();
  expect(validateComparisonSelection(f.selection, f.context)).toEqual(f.selection);
  const invalid = [
    { ...f.selection, attempt: '1' }, { ...f.selection, extra: true },
    { ...f.selection, changed: ['local/draft', 'local/draft'] },
    { ...f.selection, skills: [...f.selection.skills, ...f.selection.skills] },
    { ...f.selection, skills: [{ key: 'local/draft', hasEval: 'yes' }] },
    { ...f.selection, include: [...f.selection.include, ...f.selection.include] },
    ...[
      { id: '../../escape' }, { key: 'not-selected' }, { base: sha('e') }, { head: sha('e') },
      { directory: '../other' }, { directory: '.git' }, { directory: 'C:\\absolute' },
      { directory: 'plugins//draft' }, { evalPath: 'plugins/local/skills/draft/eval.yaml' },
      { evalPath: '/tmp/eval.yaml' }, { extra: 'unexpected' },
    ].map((entry) => ({ ...f.selection, include: [{ ...f.selection.include[0], ...entry }] })),
  ];
  for (const value of invalid) expect(() => validateComparisonSelection(value, f.context)).toThrow();
});

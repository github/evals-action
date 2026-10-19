import { describe, expect, it, vi } from 'vitest';
import {
  assertSerializedReporter, assertSerializedReusableReporter, commentConcurrencyGroup, postReport, type CommentContext,
} from '../src/reporter.js';
import { orderedBody } from '../src/comments.js';
import { type GitHubClient, ReportingError } from '../src/github.js';
import { type Report } from '../src/reporting.js';

const context: CommentContext = {
  repository: 'o/r', workflowRef: 'o/r/.github/workflows/evals.yml@refs/pull/3/merge',
  workflowSha: 'b'.repeat(40), job: 'report', reportId: 'smoke', selection: 'c'.repeat(64),
  pullNumber: 3, runId: 1000, order: { runNumber: 10, attempt: 2 },
};
const report: Report = {
  schemaVersion: 2, reportId: 'smoke', repository: 'o/r', workflowRunId: 1000,
  workflowRunAttempt: 2, sourceJob: 'evaluate', selection: context.selection,
  command: 'run', outcome: 'error', completeness: 'unknown',
  revision: 'a'.repeat(40), category: 'dependency', code: 'headless-runtime-unavailable',
};
const source = `jobs:
  report:
    concurrency:
      group: '${commentConcurrencyGroup}'
      cancel-in-progress: false
    steps:
      - uses: github/evals-action@${'c'.repeat(40)}
        with:
          command: report
          report-id: smoke
`;
const reusableSha = 'd'.repeat(40);
const reusableContext: CommentContext = {
  ...context,
  reusableWorkflow: {
    ref: `github/evals-action/.github/workflows/evals.yml@${reusableSha}`,
    sha: reusableSha,
    repository: 'github/evals-action',
    filePath: '.github/workflows/evals.yml',
  },
};
const reusableSource = `name: Evals
on:
  pull_request:
jobs:
  evals:
    uses: github/evals-action/.github/workflows/evals.yml@${reusableSha}
    with:
      working-directory: evals
      suite: smoke
    permissions:
      contents: read
      copilot-requests: write
      pull-requests: write
`;
const identity = { repository: context.repository, workflow: '.github/workflows/evals.yml', job: context.job, report: context.reportId, selection: context.selection };
const owned = (runNumber = 10, attempt = 1) => ({
  id: 20, user: { id: 42, type: 'Bot' }, body: orderedBody(identity, { runNumber, attempt }, 'prior report'),
});
type Entry = ReturnType<typeof owned>;

function fixture(options: {
  source?: string; comments?: Entry[]; failWrite?: boolean; authorLogin?: string; drift?: boolean; badReadback?: boolean;
} = {}) {
  let saved: Entry | undefined;
  let pullReads = 0;
  const request = vi.fn<GitHubClient['request']>(async (method, path, body) => {
    if (path.includes('/contents/')) return { encoding: 'base64', content: Buffer.from(options.source ?? source).toString('base64') };
    if (path.endsWith('/pulls/3')) {
      pullReads++;
      return {
        state: 'open', head: { sha: 'd'.repeat(40), repo: { full_name: 'o/r' } },
        base: { repo: { full_name: 'o/r' } }, merge_commit_sha: options.drift && pullReads > 1 ? 'e'.repeat(40) : report.revision,
      };
    }
    if (path === '/graphql') return { data: { viewer: { databaseId: 42, login: options.authorLogin ?? 'github-actions[bot]' } } };
    if (method === 'GET' && path.includes('?per_page')) {
      const page = Number(new URL(`https://example.test${path}`).searchParams.get('page'));
      return (options.comments ?? []).slice((page - 1) * 100, page * 100);
    }
    if (method === 'POST' || method === 'PATCH') {
      if (options.failWrite) throw new ReportingError('github-http-403');
      saved = { id: 20, user: { id: 42, type: 'Bot' }, body: String(body?.body) };
      return saved;
    }
    if (method === 'GET' && path.endsWith('/issues/comments/20')) {
      return options.badReadback ? { ...saved, body: 'wrong' } : saved;
    }
    throw new Error(`Unexpected synthetic request ${method} ${path}`);
  });
  const writes = () => request.mock.calls.filter(([method, path]) => method !== 'GET' && path !== '/graphql');
  return { client: { request }, writes, request };
}

describe('serialized sticky GitHub networking', () => {
  it('creates one owned comment, verifies readback, and links exact revision/run/artifact without claiming pass', async () => {
    const test = fixture();
    expect(await postReport(test.client, context, report, 123)).toBe('created');
    expect(test.writes()).toHaveLength(1);
    const [method, path, payload] = test.writes()[0]!;
    expect(method).toBe('POST');
    expect(path).toBe('/repos/o/r/issues/3/comments');
    expect(payload?.body).toContain('Evals: error');
    expect(payload?.body).toContain('headless-runtime-unavailable');
    expect(payload?.body).toContain(`/commit/${report.revision}`);
    expect(payload?.body).toContain('/actions/runs/1000/artifacts/123');
    expect(payload?.body).not.toContain('passed');
  });
  it('updates in place, ignores human comments, and paginates the complete collection', async () => {
    const human = { id: 9, user: { id: 99, type: 'User' }, body: owned().body };
    const test = fixture({ comments: [...Array.from({ length: 100 }, () => human), owned()] });
    expect(await postReport(test.client, context, report)).toBe('updated');
    expect(test.writes()).toHaveLength(1);
    expect(test.writes()[0]?.slice(0, 2)).toEqual(['PATCH', '/repos/o/r/issues/comments/20']);
    expect(test.request.mock.calls.some(([, path]) => path.endsWith('page=2'))).toBe(true);
  });
  it('does not overwrite a newer run or attempt and rejects duplicate owned comments', async () => {
    for (const existing of [owned(11, 1), owned(10, 3)]) {
      const test = fixture({ comments: [existing] });
      expect(await postReport(test.client, context, report)).toBe('stale');
      expect(test.writes()).toEqual([]);
    }
    const duplicate = fixture({ comments: [owned(), owned()] });
    await expect(postReport(duplicate.client, context, report)).rejects.toThrow(/Duplicate/);
    expect(duplicate.writes()).toEqual([]);
  });
  it('refuses human tokens and does not edit a user-authored matching marker', async () => {
    const humanToken = fixture({ authorLogin: 'person' });
    await expect(postReport(humanToken.client, context, report)).rejects.toThrow('reporting-bot-token-required');
    expect(humanToken.writes()).toEqual([]);
    const humanComment = fixture({ comments: [{ ...owned(), user: { id: 99, type: 'User' } }] });
    expect(await postReport(humanComment.client, context, report)).toBe('created');
  });
  it('refreshes source eligibility immediately before mutation', async () => {
    const test = fixture({ drift: true });
    await expect(postReport(test.client, context, report)).rejects.toThrow('pull-request-source-is-stale-or-excluded');
    expect(test.writes()).toEqual([]);
  });
  it('does not retry a denied write or repair a mismatched readback', async () => {
    const denied = fixture({ failWrite: true });
    await expect(postReport(denied.client, context, report)).rejects.toThrow('github-http-403');
    expect(denied.writes()).toHaveLength(1);
    const mismatch = fixture({ badReadback: true });
    await expect(postReport(mismatch.client, context, report)).rejects.toThrow('comment-readback-mismatch');
    expect(mismatch.writes()).toHaveLength(1);
  });
  it('escapes malicious presentation text and separates selection and parallel job identities', async () => {
    const test = fixture({ comments: [owned()] });
    expect(await postReport(test.client, { ...context, selection: 'another-suite' }, {
      ...report, code: '<script>@person\n[link](https://evil.test)',
    })).toBe('created');
    expect(test.writes()[0]?.[2]?.body).not.toContain('<script>');
    expect(test.writes()[0]?.[2]?.body).not.toContain('@person');
    expect(orderedBody({ ...identity, job: 'parallel' }, context.order, '')).not.toBe(orderedBody(identity, context.order, ''));
  });
});

describe('verified workflow serialization guard', () => {
  it('accepts the exact non-cancelling workflow group and distinct literal report steps', () => {
    assertSerializedReporter(source, context);
    assertSerializedReporter(source + '      - uses: github/evals-action@abc\n        with:\n          command: report\n          report-id: other\n', context);
  });

  describe('verified reusable workflow caller guard', () => {
    it('accepts the pinned product workflow with the minimal explicit permission ceiling', () => {
      assertSerializedReusableReporter(reusableSource, reusableContext);
    });
    it.each([
      reusableSource.replace(`@${reusableSha}`, '@main'),
      reusableSource.replace('copilot-requests: write\n', ''),
      reusableSource.replace('pull-requests: write\n', ''),
      reusableSource.replace('pull-requests: write\n', 'pull-requests: write\n      contents: write\n'),
      reusableSource.replace('      suite: smoke', '      command: shell\n      suite: smoke'),
      reusableSource.replace('on:\n  pull_request:', 'on:\n  workflow_dispatch:'),
      reusableSource.replace('jobs:\n  evals:', 'jobs:\n  evals:\n    strategy: {matrix: {os: [ubuntu-latest, windows-latest]}}'),
      reusableSource.replace('    permissions:', '    secrets: inherit\n    permissions:'),
      reusableSource + `  other:\n    uses: github/evals-action/.github/workflows/evals.yml@${reusableSha}\n`,
    ])('rejects an unpinned or over-broad caller %j', (workflow) => {
      expect(() => assertSerializedReusableReporter(workflow, reusableContext)).toThrow();
    });
    it('allows lint-only with no Copilot permission', () => {
      const lint = reusableSource
        .replace('      suite: smoke\n', '      command: lint\n')
        .replace('      copilot-requests: write\n', '');
      assertSerializedReusableReporter(lint, reusableContext);
    });
    it('requires Copilot ceiling for run-only mode', () => {
      const run = reusableSource.replace('      suite: smoke', '      command: run\n      suite: smoke');
      assertSerializedReusableReporter(run, reusableContext);
      expect(() => assertSerializedReusableReporter(
        run.replace('      copilot-requests: write\n', ''), reusableContext,
      )).toThrow(/permission-ceiling/);
    });
    it('allows the in-repository PR workflow to call its same-commit reusable workflow', () => {
      const localSource = `name: Evals
on:
    pull_request:
jobs:
    evals:
      uses: ./.github/workflows/evals.yml
      with:
        working-directory: evals
        suite: smoke
      permissions:
        contents: read
        copilot-requests: write
        pull-requests: write
`;
      assertSerializedReusableReporter(localSource, {
        ...reusableContext,
        repository: 'github/evals-action',
        workflowRef: 'github/evals-action/.github/workflows/copilot-e2e.yml@refs/pull/3/merge',
        workflowSha: reusableSha,
        reusableWorkflow: {
          ref: 'github/evals-action/.github/workflows/evals.yml@refs/pull/3/merge',
          sha: reusableSha,
          repository: 'github/evals-action',
          filePath: '.github/workflows/evals.yml',
        },
      });
    });
    it('rejects mismatched system-provided reusable workflow identity', () => {
      for (const reusableWorkflow of [
        { ...reusableContext.reusableWorkflow!, repository: 'attacker/action' },
        { ...reusableContext.reusableWorkflow!, filePath: '.github/workflows/other.yml' },
        { ...reusableContext.reusableWorkflow!, ref: 'github/evals-action/.github/workflows/evals.yml@main' },
        { ...reusableContext.reusableWorkflow!, sha: 'main' },
      ]) {
        expect(() => assertSerializedReusableReporter(reusableSource, {
          ...reusableContext, reusableWorkflow,
        })).toThrow(/reusable-workflow-source/);
      }
    });
    it('posts from a pinned reusable workflow while retaining caller workflow identity', async () => {
      const test = fixture({ source: reusableSource });
      expect(await postReport(test.client, reusableContext, report, 123)).toBe('created');
      const body = String(test.writes()[0]?.[2]?.body);
      expect(body).toContain('https://github.com/o/r/commit/');
      expect(body).toContain('https://github.com/o/r/actions/runs/1000/artifacts/123');
    });
  });
  it.each([
    source.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
    source.replace(commentConcurrencyGroup, 'unrelated'),
    source.replace('steps:', 'strategy: {matrix: {os: [linux, windows]}}\n    steps:'),
    source.replace('report-id: smoke', "report-id: '${{ matrix.os }}'"),
    source + '      - uses: github/evals-action@abc\n        with:\n          command: report\n          report-id: smoke\n',
    source.replace('report-id: smoke', 'report-id: missing'),
    'invalid: [',
  ])('refuses unsafe or ambiguous workflow topology without any write', async (workflow) => {
    const test = fixture({ source: workflow });
    await expect(postReport(test.client, context, report)).rejects.toThrow();
    expect(test.writes()).toEqual([]);
  });
  it('rejects wrong repository/ref/revision/run identities before mutation', async () => {
    for (const changed of [
      { repository: '../bad' }, { workflowSha: 'main' }, { workflowRef: 'other/r/.github/workflows/evals.yml@refs/pull/3/merge' },
      { workflowRef: 'o/r/.github/workflows/evals.yml@refs/pull/4/merge' }, { runId: 0 }, { pullNumber: -1 },
    ]) {
      const test = fixture();
      await expect(postReport(test.client, { ...context, ...changed }, report)).rejects.toThrow();
      expect(test.writes()).toEqual([]);
    }
    await expect(postReport(fixture().client, context, { ...report, revision: 'main' })).rejects.toThrow();
  });
});

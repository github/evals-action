import { describe, expect, it, vi } from 'vitest';
import { assertSerializedReporter, commentConcurrencyGroup, postReport, type CommentContext } from '../src/reporter.js';
import { orderedBody } from '../src/comments.js';
import { type GitHubClient, ReportingError } from '../src/github.js';
import { type Report } from '../src/reporting.js';

const context: CommentContext = {
  repository: 'o/r', workflowRef: 'o/r/.github/workflows/evals.yml@refs/pull/3/merge',
  workflowSha: 'b'.repeat(40), job: 'evals', reportId: 'smoke', selection: 'c'.repeat(64),
  pullNumber: 3, runId: 1000, order: { runNumber: 10, attempt: 2 },
};
const report: Report = {
  schemaVersion: 2, reportId: 'smoke', repository: 'o/r', workflowRunId: 1000,
  workflowRunAttempt: 2, sourceJob: 'evaluate', selection: context.selection,
  command: 'run', outcome: 'error', completeness: 'unknown',
  revision: 'a'.repeat(40), category: 'dependency', code: 'vally-acquisition-failed',
};
const source = `jobs:
  evals:
    concurrency:
      group: '${commentConcurrencyGroup}'
      cancel-in-progress: false
    steps:
      - uses: ./
        with:
          working-directory: evals
          suite: smoke
          report-id: smoke
`;
const identity = { repository: context.repository, workflow: '.github/workflows/evals.yml', job: 'report', report: context.reportId };
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
    if (method === 'GET' && path.endsWith('/issues/comments/20')) return options.badReadback ? { ...saved, body: 'wrong' } : saved;
    throw new Error(`Unexpected synthetic request ${method} ${path}`);
  });
  const writes = () => request.mock.calls.filter(([method, path]) => method !== 'GET' && path !== '/graphql');
  return { client: { request }, writes, request };
}

describe('one sticky PR report for direct Action calls', () => {
  it('creates one owned comment, verifies readback, and links exact revision/run/artifact without claiming pass', async () => {
    const test = fixture();
    expect(await postReport(test.client, context, report, 123)).toBe('created');
    expect(test.writes()).toHaveLength(1);
    const [method, path, payload] = test.writes()[0]!;
    expect(method).toBe('POST');
    expect(path).toBe('/repos/o/r/issues/3/comments');
    expect(payload?.body).toContain('Evals: error');
    expect(payload?.body).toContain('vally-acquisition-failed');
    expect(payload?.body).toContain(`/commit/${report.revision}`);
    expect(payload?.body).toContain('/actions/runs/1000/artifacts/123');
    expect(payload?.body).not.toContain('passed');
  });
  it('updates in place across selection changes and paginates without touching human comments', async () => {
    const human = { id: 9, user: { id: 99, type: 'User' }, body: owned().body };
    const test = fixture({ comments: [...Array.from({ length: 100 }, () => human), owned()] });
    expect(await postReport(test.client, { ...context, selection: 'new-selection' }, report)).toBe('updated');
    expect(test.writes()).toHaveLength(1);
    expect(test.writes()[0]?.slice(0, 2)).toEqual(['PATCH', '/repos/o/r/issues/comments/20']);
    expect(test.request.mock.calls.some(([, path]) => path.endsWith('page=2'))).toBe(true);
    expect(String(test.writes()[0]?.[2]?.body)).not.toContain('/artifacts/undefined');
  });
  it('does not overwrite newer runs or attempts and rejects duplicate owned comments', async () => {
    for (const existing of [owned(11, 1), owned(10, 3)]) {
      const test = fixture({ comments: [existing] });
      expect(await postReport(test.client, context, report)).toBe('stale');
      expect(test.writes()).toEqual([]);
    }
    const duplicate = fixture({ comments: [owned(), owned()] });
    await expect(postReport(duplicate.client, context, report)).rejects.toThrow(/Duplicate/);
    expect(duplicate.writes()).toEqual([]);
  });
  it('refuses human tokens and refreshes source eligibility before writing', async () => {
    const human = fixture({ authorLogin: 'person' });
    await expect(postReport(human.client, context, report)).rejects.toThrow('reporting-bot-token-required');
    const stale = fixture({ drift: true });
    await expect(postReport(stale.client, context, report)).rejects.toThrow('pull-request-source-is-stale-or-excluded');
    expect(human.writes()).toEqual([]);
    expect(stale.writes()).toEqual([]);
  });
  it('does not retry a denied write or repair a mismatched readback', async () => {
    const denied = fixture({ failWrite: true });
    await expect(postReport(denied.client, context, report)).rejects.toThrow('github-http-403');
    expect(denied.writes()).toHaveLength(1);
    const mismatch = fixture({ badReadback: true });
    await expect(postReport(mismatch.client, context, report)).rejects.toThrow('comment-readback-mismatch');
    expect(mismatch.writes()).toHaveLength(1);
  });
  it('renders suite, names, and both statuses in one comment and updates it for lint-only', async () => {
    const test = fixture();
    const evaluation: Report = {
      ...report, suite: 'selected-suite @team', outcome: 'passed', executed: 1,
      passed: 1, failed: 0, groups: [{
        identity: 'a'.repeat(64), name: 'named-eval | @team', passed: true,
        trials: 1, stimuliRun: 1, stimuliTotal: 1, skipped: 0,
      }],
    };
    const lint: Report = { ...report, sourceJob: 'lint', reportId: 'smoke-lint', command: 'lint', outcome: 'validated', executed: 0 };
    expect(await postReport(test.client, context, evaluation, 123, { report: lint, artifactId: 124 })).toBe('created');
    const body = String(test.writes()[0]?.[2]?.body);
    expect(test.writes()).toHaveLength(1);
    expect(body).toContain('/artifacts/124');
    expect(body).toContain('Suite:** selected-suite &#64;team');
    expect(body).toContain('named-eval \\| &#64;team');
    expect(body).toContain('Lint:** validated');
    expect(body).toContain('Run:** passed - 1 trial');
    expect(body).not.toContain('a'.repeat(64));
    const update = fixture({ comments: [{ ...owned(), body }] });
    expect(await postReport(update.client, context, lint, 124)).toBe('updated');
    expect(update.writes()[0]?.[0]).toBe('PATCH');
    expect(update.writes()[0]?.[2]?.body).not.toContain('**Run:**');
  });
  it('renders the Quality & token summary table in the sticky PR comment and bounds it within the comment byte budget', async () => {
    const test = fixture();
    const evaluation: Report = {
      ...report, suite: 'smoke', outcome: 'passed', executed: 2,
      passed: 1, failed: 0, durationMs: 120,
      tokens: { input: 300, output: 150, total: 450 },
      groups: [{
        identity: 'a'.repeat(64), name: 'skill-check', passed: true,
        trials: 2, stimuliRun: 2, stimuliTotal: 2, skipped: 0,
        overallScore: 0.95, threshold: 0.8, durationMs: 120,
        tokens: { input: 300, output: 150, total: 450 },
      }],
    };
    const lint: Report = { ...report, sourceJob: 'lint', reportId: 'smoke-lint', command: 'lint', outcome: 'validated', executed: 0 };
    expect(await postReport(test.client, context, evaluation, 123, { report: lint, artifactId: 124 })).toBe('created');
    const body = String(test.writes()[0]?.[2]?.body);
    expect(body).toContain('| Eval | Trials | Result |');
    expect(body).toContain('### Quality & token summary');
    expect(body).toContain('| Eval | Verdict | Score | Duration | Tokens |');
    expect(body).toContain('| skill-check | passed | 0.95 (threshold 0.80) | 120ms | 450 tokens (300 in / 150 out) |');

    const manyGroups = Array.from({ length: 40 }, (_, index) => ({
      identity: index.toString(16).padStart(64, '0'),
      name: `group-${index}-${'x'.repeat(240)}`,
      passed: true,
      trials: 1,
      stimuliRun: 1,
      stimuliTotal: 1,
      skipped: 0,
      overallScore: 0.9,
      threshold: 0.8,
      durationMs: 50,
      tokens: { input: 20, output: 30, total: 50 },
    }));
    const largeEvaluation: Report = {
      ...report, suite: 'smoke', outcome: 'passed', executed: 40,
      passed: 40, failed: 0, durationMs: 2000,
      tokens: { input: 800, output: 1200, total: 2000 },
      groups: manyGroups,
    };
    const largeTest = fixture();
    expect(await postReport(largeTest.client, context, largeEvaluation, 123, { report: lint, artifactId: 124 })).toBe('created');
    const largeBody = String(largeTest.writes()[0]?.[2]?.body);
    expect(largeBody).toContain('Further groups are available in the structured artifact.');
    expect(Buffer.byteLength(largeBody, 'utf8')).toBeLessThanOrEqual(60_000);

    const ampersandGroups = Array.from({ length: 100 }, (_, index) => ({
      identity: index.toString(16).padStart(64, '0'),
      name: `${'&'.repeat(90)}-${index}`,
      passed: true,
      trials: 1,
      stimuliRun: 1,
      stimuliTotal: 1,
      skipped: 0,
      overallScore: 0.9,
      threshold: 0.8,
      durationMs: 50,
      tokens: { input: 20, output: 30, total: 50 },
    }));
    const ampersandEvaluation: Report = {
      ...report, suite: 'smoke', outcome: 'passed', executed: 100,
      passed: 100, failed: 0, durationMs: 5000,
      tokens: { input: 2000, output: 3000, total: 5000 },
      groups: ampersandGroups,
    };
    const ampersandTest = fixture();
    expect(await postReport(ampersandTest.client, context, ampersandEvaluation, 123, { report: lint, artifactId: 124 })).toBe('created');
    const ampersandBody = String(ampersandTest.writes()[0]?.[2]?.body);
    expect(ampersandBody).toContain('### Quality & token summary');
    expect(ampersandBody).toContain('Further groups are available in the structured artifact.');
    expect(Buffer.byteLength(ampersandBody, 'utf8')).toBeLessThanOrEqual(60_000);
  });
  it('reports failed evaluations and lint failures accurately', async () => {
    const test = fixture();
    const failure: Report = { ...report, outcome: 'failed', executed: 1, failed: 1, passed: 0 };
    const lint: Report = { ...report, reportId: 'smoke-lint', command: 'lint', outcome: 'validated', executed: 0 };
    await postReport(test.client, context, failure, 123, { report: lint, artifactId: 124 });
    expect(test.writes()[0]?.[2]?.body).toContain('# Evals: failed');
    expect(test.writes()[0]?.[2]?.body).toContain('Lint:** validated');
    const lintFailure = fixture();
    await postReport(lintFailure.client, context, { ...lint, outcome: 'error', code: 'native-lint-failed' }, 124);
    expect(lintFailure.writes()[0]?.[2]?.body).toContain('Lint:** error - native-lint-failed');
    expect(lintFailure.writes()[0]?.[2]?.body).not.toContain('**Run:**');
  });
  it('rejects mismatched companion evidence before contacting GitHub', async () => {
    const test = fixture();
    await expect(postReport(test.client, context, report, 123, {
      report: { ...report, reportId: 'smoke-lint', command: 'lint', revision: 'f'.repeat(40) }, artifactId: 124,
    })).rejects.toThrow('inconsistent-report-evidence');
    expect(test.request).not.toHaveBeenCalled();
  });
  it('accepts the same report identity for separate lint/run jobs but still requires successful lint', async () => {
    const lint: Report = { ...report, command: 'lint', outcome: 'validated', executed: 0 };
    const test = fixture();
    expect(await postReport(test.client, context, report, 123, { report: lint, artifactId: 124 })).toBe('created');
    expect(test.writes()[0]?.[2]?.body).toContain('Lint:** validated');
    for (const changed of [
      { reportId: 'other' }, { outcome: 'error' as const }, { command: 'run' }, { workflowRunAttempt: 1 },
    ]) {
      const invalid = fixture();
      await expect(postReport(invalid.client, context, report, 123, { report: { ...lint, ...changed }, artifactId: 124 }))
        .rejects.toThrow('inconsistent-report-evidence');
      expect(invalid.request).not.toHaveBeenCalled();
    }
  });
});

describe('direct workflow source validation', () => {
  it.each(['', '          command: all\n', '          command: report\n'])('accepts default, all, and report steps', (command) => {
    assertSerializedReporter(source.replace('          report-id:', `${command}          report-id:`), context);
  });
  it('normalizes isolated report suffixes to the same comment identity', () => {
    assertSerializedReporter(source.replace('report-id: smoke', 'command: report\n          report-id: smoke-run'), context);
  });
  it('allows distinct lint/run report steps sharing one serialized identity', () => {
    const pair = source.replace('report-id: smoke', 'command: report\n          report-id: smoke-run') +
      '      - uses: github/evals-action@abc\n        with:\n          command: report\n          report-id: smoke-lint\n';
    assertSerializedReporter(pair, context);
    expect(() => assertSerializedReporter(pair.replace('report-id: smoke-lint', 'report-id: smoke-run'), context)).toThrow();
  });
  it.each([
    source.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
    source.replace(commentConcurrencyGroup, 'unrelated'),
    source.replace('steps:', 'strategy: {matrix: {os: [linux, windows]}}\n    steps:'),
    source.replace('report-id: smoke', "report-id: '${{ matrix.os }}'"),
    source + '      - uses: github/evals-action@abc\n        with:\n          command: report\n          report-id: smoke\n',
    source.replace('report-id: smoke', 'report-id: missing'),
    source.replace('report-id: smoke', 'command: lint\n          report-id: smoke'),
    'invalid: [',
  ])('refuses unsafe or ambiguous topology without writes', async (workflow) => {
    const test = fixture({ source: workflow });
    await expect(postReport(test.client, context, report)).rejects.toThrow();
    expect(test.writes()).toEqual([]);
  });
  it('rejects wrong repository/ref/revision/run identities', async () => {
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

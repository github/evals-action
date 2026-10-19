import { describe, expect, it } from 'vitest';
import {
  displayCount, escapeMarkdown, parseStructuredReport, renderMatrix, renderSummary, structuredReport, type Report,
} from '../src/reporting.js';
import { commentMarker, orderedBody, selectComment } from '../src/comments.js';

describe('minimal presentation projections', () => {
  const report = (overrides: Partial<Report> = {}): Report => ({
    schemaVersion: 2, reportId: 'evals', repository: 'o/r', workflowRunId: 100, workflowRunAttempt: 1,
    sourceJob: 'evaluate', selection: 'b'.repeat(64), command: 'run', outcome: 'not-run',
    completeness: 'complete', revision: 'a'.repeat(40), category: 'none',
    code: 'native-empty-selection', executed: 0, ...overrides,
  });
  it('preserves count certainty and does not multiply heterogeneous rows', () => {
    expect(displayCount({ kind: 'exact', value: 4, unit: 'trials' })).toBe('4 trials');
    expect(displayCount({ kind: 'bounded', minimum: 0, maximum: 8, unit: 'retries', reason: 'conditional' })).toBe('0-8 retries (conditional)');
    expect(displayCount({ kind: 'unknown', unit: 'calls', reason: 'dynamic' })).toBe('unknown: calls (dynamic)');
    expect(displayCount({ kind: 'not-applicable', unit: 'comparisons', reason: 'not configured' })).toContain('not-applicable');
    const text = renderMatrix([{
      eval: 'one', case: 'case', variant: 'variant', model: 'model',
      repetitions: { kind: 'exact', value: 2, unit: 'trials' },
      workers: { kind: 'exact', value: 1, unit: 'workers' },
      timeout: { kind: 'unknown', unit: 'seconds', reason: 'native default' },
      conditionalRetries: { kind: 'bounded', minimum: 0, maximum: 4, unit: 'retries', reason: 'conditional' },
    }], 'partial');
    expect(text).toContain('(partial)');
    expect(text).toContain('2 trials');
    expect(text).toContain('Trials are not API calls or currency');
    expect(text).not.toContain('total');
  });
  it('escapes table injection, links, HTML and mentions', () => {
    expect(escapeMarkdown('<img>\n| [x](url) @team & `code`')).toBe('&lt;img&gt; \\| \\[x\\]\\(url\\) &#64;team &amp; \\`code\\`');
  });
  it('does not turn unknown counts or not-run into a pass', () => {
    const notRun = report();
    expect(renderSummary(notRun)).toContain('Not an evaluation pass');
    expect(renderSummary(notRun)).toContain('Executed: 0');
    const unknown: Report = { ...notRun };
    delete unknown.executed;
    expect(renderSummary(unknown)).toContain('Executed: unknown');
    const serialized = structuredReport({ ...notRun, secret: 'must not appear', transcript: 'private' } as Report);
    expect(serialized).not.toMatch(/secret|private|transcript/);
    expect(JSON.parse(serialized)).not.toHaveProperty('passed');
    expect(JSON.parse(structuredReport({
      ...notRun, passed: 0, failed: 0,
      engine: { version: '0.19.0', sha256: 'engine' },
    }))).toMatchObject({ passed: 0, failed: 0, engine: { version: '0.19.0' } });
  });
  it('validates a downloaded report against the exact workflow identity', () => {
    const source = report({
      outcome: 'passed', executed: 1, passed: 1, failed: 0,
      groups: [{ identity: 'c'.repeat(64), passed: true, trials: 1, stimuliRun: 1, stimuliTotal: 1, skipped: 0 }],
      engine: { version: '0.19.0', sha256: 'd'.repeat(64), dependencySha256: 'e'.repeat(64), lockSha256: 'f'.repeat(64) },
    });
    const text = structuredReport(source);
    expect(parseStructuredReport(text, {
      reportId: 'evals', repository: 'o/r', workflowRunId: 100,
      workflowRunAttempt: 1, revision: 'a'.repeat(40),
    })).toEqual(source);
    for (const expected of [
      { reportId: 'other' }, { repository: 'other/r' }, { workflowRunId: 101 },
      { workflowRunAttempt: 2 }, { revision: '9'.repeat(40) },
    ]) {
      expect(() => parseStructuredReport(text, {
        reportId: 'evals', repository: 'o/r', workflowRunId: 100,
        workflowRunAttempt: 1, revision: 'a'.repeat(40), ...expected,
      })).toThrow(/identity/);
    }
  });
  it('rejects arbitrary, malformed, inconsistent, oversized or recursively reportable data', () => {
    const expectation = {
      reportId: 'evals', repository: 'o/r', workflowRunId: 100,
      workflowRunAttempt: 1, revision: 'a'.repeat(40),
    };
    const mutate = (change: Record<string, unknown>) => JSON.stringify({ ...report(), ...change });
    for (const text of [
      'not-json', mutate({ schemaVersion: 1 }), mutate({ extra: 'raw runner data' }),
      mutate({ command: 'report' }), mutate({ outcome: 'passed', executed: 0, failed: 0 }),
      mutate({ outcome: 'failed', executed: 1, failed: 0 }),
      mutate({ outcome: 'not-run', executed: 1 }),
      mutate({ outcome: 'validated', command: 'run', executed: 0 }),
      mutate({
        outcome: 'passed', executed: 1, passed: 1, failed: 0,
        groups: [{ identity: 'c'.repeat(64), passed: false, trials: 1, stimuliRun: 1, stimuliTotal: 1, skipped: 0 }],
      }),
      mutate({
        outcome: 'failed', executed: 1, passed: 1, failed: 0,
        groups: [{ identity: 'c'.repeat(64), passed: true, trials: 1, stimuliRun: 1, stimuliTotal: 1, skipped: 0 }],
      }),
      mutate({
        outcome: 'passed', executed: 1, passed: 1, failed: 0,
        groups: [{ identity: 'c'.repeat(64), passed: true, trials: 1, stimuliRun: 2, stimuliTotal: 2, skipped: 0 }],
      }),
      mutate({
        outcome: 'not-run', executed: 0, passed: 0, failed: 0,
        groups: [{ identity: 'c'.repeat(64), passed: true, trials: 0, stimuliRun: 1, stimuliTotal: 1, skipped: 0 }],
      }),
      mutate({
        outcome: 'failed', executed: 1, passed: 0, failed: 1,
        groups: [{ identity: 'c'.repeat(64), passed: false, trials: 1, stimuliRun: 0, stimuliTotal: 1, skipped: 1 }],
      }),
      mutate({ outcome: 'not-run', executed: 0, groups: undefined }),
      mutate({ groups: Array.from({ length: 10_001 }, () => ({})) }),
    ]) expect(() => parseStructuredReport(text, expectation)).toThrow();
  });
});

describe('sticky report ordering policy (network integration pending)', () => {
  const identity = { repository: 'o/r', workflow: 'ci.yml', job: 'evals', report: 'linux-suite' };
  const order = { runNumber: 12, attempt: 2 };
  const comment = { id: 5, authorId: 42, body: orderedBody(identity, order, 'report') };
  it('updates only exact identity and authenticated author', () => {
    expect(selectComment([], identity, order, 42)).toEqual({ action: 'create' });
    expect(selectComment([comment], identity, order, 42)).toEqual({ action: 'update', id: 5 });
    expect(selectComment([comment], identity, order, 43)).toEqual({ action: 'create' });
    expect(selectComment([comment], { ...identity, report: 'other' }, order, 42)).toEqual({ action: 'create' });
  });
  it('does not let late older runs or attempts replace a newer report', () => {
    expect(selectComment([comment], identity, { runNumber: 11, attempt: 99 }, 42)).toEqual({ action: 'stale' });
    expect(selectComment([comment], identity, { runNumber: 12, attempt: 1 }, 42)).toEqual({ action: 'stale' });
    expect(selectComment([comment], identity, { runNumber: 13, attempt: 1 }, 42)).toEqual({ action: 'update', id: 5 });
  });
  it('rejects invalid order, duplicate owned comments and malformed markers', () => {
    expect(() => orderedBody(identity, { runNumber: 0, attempt: 1 }, '')).toThrow();
    expect(() => selectComment([comment, comment], identity, order, 42)).toThrow(/Duplicate/);
    expect(() => selectComment([{ ...comment, body: `${commentMarker(identity)}\nno order` }], identity, order, 42)).toThrow(/metadata/);
  });
});

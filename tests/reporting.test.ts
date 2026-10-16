import { describe, expect, it } from 'vitest';
import { displayCount, escapeMarkdown, renderMatrix, renderSummary, structuredReport, type Report } from '../src/reporting.js';
import { commentMarker, orderedBody, selectComment } from '../src/comments.js';

describe('minimal presentation projections', () => {
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
    const report: Report = {
      schemaVersion: 1, command: 'run', outcome: 'not-run', completeness: 'unknown',
      revision: 'a'.repeat(40), category: 'policy', code: 'fork-execution-excluded', executed: 0,
    };
    expect(renderSummary(report)).toContain('Not an evaluation pass');
    expect(renderSummary(report)).toContain('Executed: 0');
    const unknown: Report = { ...report };
    delete unknown.executed;
    expect(renderSummary(unknown)).toContain('Executed: unknown');
    const serialized = structuredReport({ ...report, secret: 'must not appear', transcript: 'private' } as Report);
    expect(serialized).not.toMatch(/secret|private|transcript/);
    expect(JSON.parse(serialized)).not.toHaveProperty('passed');
    expect(JSON.parse(structuredReport({
      ...report, passed: 0, failed: 0,
      engine: { version: '0.19.0', sha256: 'engine' },
    }))).toMatchObject({ passed: 0, failed: 0, engine: { version: '0.19.0' } });
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

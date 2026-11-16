import { describe, expect, it } from 'vitest';
import {
  classifyGroupTransition, displayCount, escapeMarkdown, formatDurationDelta, formatScoreDelta,
  formatSignedCount, formatTokenDelta, parseStructuredReport, renderComparisonSection,
  renderMatrix, renderSummary, structuredReport, type Report,
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
  it('renders native eval names and suite selection without raw source paths', () => {
    const source = report({
      outcome: 'passed', suite: 'smoke @team', executed: 1, passed: 1, failed: 0,
      groups: [{
        identity: 'c'.repeat(64), name: 'my-eval | @team', passed: true,
        trials: 1, stimuliRun: 1, stimuliTotal: 1, skipped: 0,
      }],
    });
    const text = structuredReport(source);
    const parsed = parseStructuredReport(text, {
      reportId: 'evals', repository: 'o/r', workflowRunId: 100,
      workflowRunAttempt: 1, revision: 'a'.repeat(40),
    });
    expect(parsed.groups?.[0]?.name).toBe('my-eval | @team');
    const summary = renderSummary(parsed);
    expect(summary).toContain('Suite: smoke &#64;team');
    expect(summary).toContain('my-eval \\| &#64;team');
    expect(summary).not.toContain('c'.repeat(64));
    expect(text).not.toContain('evalFilePath');
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
      mutate({ suite: 'bad\nsuite' }),
      mutate({ suite: 'lint-only', command: 'lint' }),
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
        outcome: 'passed', executed: 1, passed: 1, failed: 0,
        groups: [{ identity: 'c'.repeat(64), name: 'bad\nname', passed: true, trials: 1, stimuliRun: 1, stimuliTotal: 1, skipped: 0 }],
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
      mutate({ groups: Array.from({ length: 1001 }, () => ({})) }),
    ]) expect(() => parseStructuredReport(text, expectation)).toThrow();
  });
  it('round-trips and validates optional group scores, duration, and tokens while enforcing byte budgets', () => {
    const expectation = {
      reportId: 'evals', repository: 'o/r', workflowRunId: 100,
      workflowRunAttempt: 1, revision: 'a'.repeat(40),
    };
    const rich = report({
      outcome: 'passed', executed: 2, passed: 1, failed: 0,
      durationMs: 120,
      tokens: { input: 300, output: 150, total: 450 },
      groups: [{
        identity: 'c'.repeat(64), name: 'rich-eval', passed: true,
        trials: 2, stimuliRun: 2, stimuliTotal: 2, skipped: 0,
        overallScore: 0.95, threshold: 0.8, durationMs: 120,
        tokens: { input: 300, output: 150, total: 450 },
      }],
    });
    const serialized = structuredReport(rich);
    const parsed = parseStructuredReport(serialized, expectation);
    expect(parsed).toEqual(rich);
    const summary = renderSummary(parsed);
    expect(summary).toContain('Duration: 120ms. Tokens: 450 (300 in / 150 out).');
    expect(summary).toContain('| Eval | Trials executed | Stimuli run | Skipped | Native verdict |');
    expect(summary).toContain('## Quality and token usage');
    expect(summary).toContain('| Eval | Verdict | Score | Duration | Tokens |');
    expect(summary).toContain('| rich-eval | passed | 0.95 (threshold 0.80) | 120ms | 450 tokens (300 in / 150 out) |');

    // Enforces 25-group cap and UTF-8 byte budget on the quality table.
    const manyGroups = Array.from({ length: 30 }, (_, index) => ({
      identity: index.toString(16).padStart(64, '0'),
      name: `eval-${index}-${'&'.repeat(200)}`,
      passed: true,
      trials: 1,
      stimuliRun: 1,
      stimuliTotal: 1,
      skipped: 0,
      overallScore: 0.9,
      threshold: 0.8,
      durationMs: 10,
      tokens: { input: 5, output: 5, total: 10 },
    }));
    const largeReport = report({
      outcome: 'passed',
      executed: 30,
      passed: 30,
      failed: 0,
      durationMs: 300,
      tokens: { input: 150, output: 150, total: 300 },
      groups: manyGroups,
    });
    const largeSummary = renderSummary(largeReport);
    expect(largeSummary).toContain('Further groups are available in the structured artifact.');
    expect(Buffer.byteLength(largeSummary, 'utf8')).toBeLessThan(100_000);

    // Enforces 1,000,000-byte artifact budget for 1,000 CJK-named groups with metrics.
    const cjkGroups = Array.from({ length: 1000 }, (_, index) => ({
      identity: index.toString(16).padStart(64, '0'),
      name: `${'測'.repeat(220)}${index}`,
      passed: true,
      trials: 1,
      stimuliRun: 1,
      stimuliTotal: 1,
      skipped: 0,
      overallScore: 0.95,
      threshold: 0.8,
      durationMs: 10,
      tokens: { input: 5, output: 5, total: 10 },
    }));
    const cjkReport = report({
      outcome: 'passed',
      executed: 1000,
      passed: 1000,
      failed: 0,
      durationMs: 10_000,
      tokens: { input: 5_000, output: 5_000, total: 10_000 },
      groups: cjkGroups,
    });
    const cjkSerialized = structuredReport(cjkReport);
    expect(Buffer.byteLength(cjkSerialized, 'utf8')).toBeLessThanOrEqual(1_000_000);
    const cjkParsed = parseStructuredReport(cjkSerialized, expectation);
    expect(cjkParsed.durationMs).toBe(10_000);
    expect(cjkParsed.tokens).toEqual({ input: 5_000, output: 5_000, total: 10_000 });
    expect(cjkParsed.groups).toHaveLength(1000);
    expect(cjkParsed.groups?.[0]?.overallScore).toBeUndefined();

    const escapedControlGroups = Array.from({ length: 1000 }, (_, i) => ({
      identity: i.toString(16).padStart(64, '0'),
      name: `${'\u0001'.repeat(134)}${i}`,
      passed: true,
      trials: 1,
      stimuliRun: 1,
      stimuliTotal: 1,
      skipped: 0,
      overallScore: 0.9,
      threshold: 0.8,
      durationMs: 10,
      tokens: { input: 5, output: 5, total: 10 },
    }));
    const escapedControlReport = report({
      outcome: 'passed',
      executed: 1000,
      passed: 1000,
      failed: 0,
      durationMs: 10_000,
      tokens: { input: 5_000, output: 5_000, total: 10_000 },
      groups: escapedControlGroups,
    });
    const escapedControlSerialized = structuredReport(escapedControlReport);
    expect(Buffer.byteLength(escapedControlSerialized, 'utf8')).toBeLessThanOrEqual(1_000_000);
    const escapedControlParsed = parseStructuredReport(escapedControlSerialized, expectation);
    expect(escapedControlParsed.groups).toHaveLength(1000);
    expect(escapedControlParsed.groups?.[0]?.name).toBeUndefined();
    expect(escapedControlParsed.durationMs).toBe(10_000);
    expect(escapedControlParsed.tokens).toEqual({ input: 5_000, output: 5_000, total: 10_000 });

    const partialGroupMetrics = report({
      outcome: 'passed',
      executed: 4,
      passed: 2,
      failed: 0,
      groups: [
        rich.groups![0]!,
        {
          identity: 'd'.repeat(64), name: 'partial-metrics', passed: true,
          trials: 2, stimuliRun: 2, stimuliTotal: 2, skipped: 0,
        },
      ],
    });
    expect(parseStructuredReport(structuredReport(partialGroupMetrics), expectation)).toEqual(partialGroupMetrics);

    const badGroup = (overrides: Record<string, unknown>) => JSON.stringify({
      ...rich,
      groups: [{ ...rich.groups![0], ...overrides }],
    });
    for (const invalid of [
      JSON.stringify({ ...rich, durationMs: -1 }),
      JSON.stringify({ ...rich, durationMs: 999 }),
      JSON.stringify({ ...rich, tokens: { total: -1 } }),
      JSON.stringify({ ...rich, tokens: { input: 300, total: 450 } }),
      JSON.stringify({ ...rich, tokens: { input: 300, output: 200, total: 450 } }),
      JSON.stringify({ ...rich, tokens: { input: 300, output: 150, total: 999 } }),
      JSON.stringify({ ...rich, tokens: { total: 10, extra: 1 } }),
      JSON.stringify({ ...report(), durationMs: 10, groups: [] }),
      JSON.stringify({ ...report(), tokens: { total: 10 }, groups: [] }),
      JSON.stringify({
        ...rich,
        executed: 4,
        passed: 2,
        durationMs: 240,
        tokens: { input: 600, output: 300, total: 900 },
        groups: [
          rich.groups![0],
          {
            identity: 'd'.repeat(64), name: 'partial-metrics', passed: true,
            trials: 2, stimuliRun: 2, stimuliTotal: 2, skipped: 0,
          },
        ],
      }),
      badGroup({ overallScore: 1.2 }),
      badGroup({ overallScore: -0.1 }),
      badGroup({ threshold: 2 }),
      badGroup({ overallScore: 0.9, threshold: undefined }),
      badGroup({ durationMs: -5 }),
      badGroup({ tokens: { input: -1, output: 5, total: 4 } }),
      badGroup({ tokens: { input: 10, total: 10 } }),
      badGroup({ tokens: { input: 6, output: 6, total: 10 } }),
      badGroup({ cases: [{ stimulus: 'not-allowed', passed: true }] }),
      JSON.stringify({
        ...report({ outcome: 'not-run', executed: 0, passed: 0, failed: 0 }),
        groups: [{
          identity: 'c'.repeat(64), name: 'skipped-eval', passed: true,
          trials: 0, stimuliRun: 0, stimuliTotal: 1, skipped: 1,
          durationMs: 10,
        }],
      }),
      JSON.stringify({
        ...report({ outcome: 'not-run', executed: 0, passed: 0, failed: 0 }),
        groups: [{
          identity: 'c'.repeat(64), name: 'skipped-eval', passed: true,
          trials: 0, stimuliRun: 0, stimuliTotal: 1, skipped: 1,
          tokens: { total: 10 },
        }],
      }),
    ]) {
      expect(() => parseStructuredReport(invalid, expectation)).toThrow();
    }
  });
  it('renders Baseline vs. Candidate comparison summaries, group transitions, and byte budgets', () => {
    const baseline = report({
      reportId: 'evals-baseline',
      outcome: 'failed', executed: 2, passed: 0, failed: 1,
      durationMs: 38_523,
      tokens: { input: 71_752, output: 1_447, total: 73_199 },
      groups: [{
        identity: 'c'.repeat(64), name: 'pr-description', passed: false,
        trials: 2, stimuliRun: 2, stimuliTotal: 2, skipped: 0,
        overallScore: 0.9375, threshold: 1, durationMs: 38_523,
        tokens: { input: 71_752, output: 1_447, total: 73_199 },
      }],
    });
    const candidate = report({
      outcome: 'passed', executed: 2, passed: 1, failed: 0,
      durationMs: 34_122,
      tokens: { input: 72_017, output: 991, total: 73_008 },
      groups: [{
        identity: 'c'.repeat(64), name: 'pr-description', passed: true,
        trials: 2, stimuliRun: 2, stimuliTotal: 2, skipped: 0,
        overallScore: 1, threshold: 1, durationMs: 34_122,
        tokens: { input: 72_017, output: 991, total: 73_008 },
      }],
    });
    const summary = renderSummary(candidate, baseline);
    expect(summary).toContain('## Baseline vs. Candidate comparison');
    expect(summary).toContain('| Outcome | failed | passed | fixed |');
    expect(summary).toContain('| Passed | 0 | 1 | +1 |');
    expect(summary).toContain('| Failed | 1 | 0 | -1 |');
    expect(summary).toContain('| Duration | 38523ms | 34122ms | -4401ms (-11.4%) |');
    expect(summary).toContain('| Tokens | 73199 tokens (71752 in / 1447 out) | 73008 tokens (72017 in / 991 out) | -191 tokens (-0.3%; out: -456 / -31.5%) |');
    expect(summary).toContain('| pr-description | failed (0.94) | passed (1.00) | +0.06 | -4401ms (-11.4%) | -191 tokens (-0.3%; out: -456 / -31.5%) | fixed |');

    expect(formatSignedCount(undefined, 1)).toBe('-');
    expect(formatSignedCount(2, 2)).toBe('0');
    expect(formatScoreDelta(undefined, 1)).toBe('-');
    expect(formatScoreDelta(0.9, 0.9)).toBe('0.00');
    expect(formatScoreDelta(0.9, 0.7)).toBe('-0.20');
    expect(formatDurationDelta(undefined, 10)).toBe('-');
    expect(formatDurationDelta(100, 100)).toBe('0ms (0.0%)');
    expect(formatDurationDelta(100, 150)).toBe('+50ms (+50.0%)');
    expect(formatTokenDelta(undefined, { total: 10 })).toBe('-');
    expect(formatTokenDelta({ total: 100 }, { total: 100 })).toBe('0 tokens (0.0%)');
    expect(formatTokenDelta({ total: 0 }, { total: 0 })).toBe('0 tokens (0.0%)');
    expect(formatTokenDelta({ input: 50, output: 50, total: 100 }, { input: 60, output: 60, total: 120 }))
      .toBe('+20 tokens (+20.0%; out: +10 / +20.0%)');

    const baseGroup = baseline.groups![0]!;
    const candGroup = candidate.groups![0]!;
    expect(classifyGroupTransition(undefined, candGroup)).toBe('added');
    expect(classifyGroupTransition(baseGroup, undefined)).toBe('removed');
    expect(classifyGroupTransition({ ...baseGroup, trials: 0, stimuliRun: 0 }, candGroup)).toBe('not-run');
    expect(classifyGroupTransition(candGroup, baseGroup)).toBe('regressed');
    expect(classifyGroupTransition({ ...candGroup, overallScore: 0.8 }, { ...candGroup, overallScore: 0.95 })).toBe('improved-score');
    expect(classifyGroupTransition({ ...candGroup, overallScore: 0.95 }, { ...candGroup, overallScore: 0.8 })).toBe('regressed');
    expect(classifyGroupTransition({ ...candGroup, tokens: { total: 200 } }, { ...candGroup, tokens: { total: 100 } })).toBe('reduced-tokens');
    expect(classifyGroupTransition({ ...candGroup, tokens: { total: 100 } }, { ...candGroup, tokens: { total: 200 } })).toBe('increased-tokens');
    expect(classifyGroupTransition({ ...candGroup, tokens: { total: 100 } }, { ...candGroup, tokens: { total: 100 } })).toBe('unchanged');

    expect(renderComparisonSection('### Compare', baseline, candidate, 25, 0)).toBe('');
    expect(renderComparisonSection('### Compare', baseline, candidate, 25, 50)).toBe('');
    const noGroups = renderComparisonSection('### Compare', { ...baseline, groups: [] }, { ...candidate, groups: [] });
    expect(noGroups).toContain('| Outcome | failed | passed | fixed |');
    expect(noGroups).not.toContain('| Eval | Baseline |');
    const regressedSummary = renderComparisonSection('### Compare', candidate, baseline);
    expect(regressedSummary).toContain('| Outcome | passed | failed | regressed |');
    const unchangedSummary = renderComparisonSection('### Compare', candidate, { ...candidate, executed: 4 });
    expect(unchangedSummary).toContain('| Outcome | passed | passed | unchanged |');
    expect(unchangedSummary).toContain('| Duration | 34122ms | 34122ms | - |');
    const otherTransition = renderComparisonSection('### Compare', report({ outcome: 'error' }), report({ outcome: 'cancelled' }));
    expect(otherTransition).toContain('| Outcome | error | cancelled | error -> cancelled |');
    const tightBudget = renderComparisonSection('### Compare', baseline, candidate, 25, 380);
    expect(tightBudget).toContain('| Outcome | failed | passed | fixed |');
    expect(tightBudget).not.toContain('| pr-description |');
    const rowOverflowBudget = renderComparisonSection('### Compare', baseline, candidate, 25, 460);
    expect(rowOverflowBudget).toContain('| Outcome | failed | passed | fixed |');
    expect(rowOverflowBudget).not.toContain('| pr-description |');
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

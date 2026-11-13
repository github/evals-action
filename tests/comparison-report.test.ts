import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  collectNative, loadComparison, renderComparison,
  type ComparisonArm, type ComparisonPair, type ComparisonSelection,
} from '../src/comparison-report.js';
import { parseNativeEvidence } from '../src/native.js';
import { sha256 } from '../src/tooling.js';

const evalPath = 'evals/local/skills/draft/eval.yaml';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const root = await mkdtemp(resolve('.comparison-report-'));
  directories.push(root);
  return root;
}

function grade(passed = false): Record<string, unknown> {
  return { passed, score: passed ? 1 : 0.5, details: [
    { graderType: 'completed', configuredName: 'completed', passed: true, score: 1 },
    { graderType: 'skill-invocation', configuredName: 'routing', passed, score: passed ? 1 : 0,
      evidence: 'SECRET_RAW_GRADER_OUTPUT', reason: 'SECRET_RAW_EXCEPTION' },
  ] };
}
function trial(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'trial-result', runId: 'native', itemId: 'item-1', evalName: 'draft',
    stimulus: 'draft-positive', model: 'model-a', variant: 'main', evalFilePath: evalPath,
    status: 'success', gradeResult: grade(),
    trajectory: { id: 'trajectory-1', output: 'SECRET_RAW_ANSWER', events: [] },
    ...overrides,
  };
}
function footer(group: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'run-summary', runId: 'native', hadExecutionErrors: false, passed: false,
    evals: [{ evalFilePath: evalPath, variant: 'main', model: 'model-a', scoringApplied: false,
      passed: false, stimuliRun: 1, stimuliTotal: 1, ...group }],
    ...overrides,
  };
}
function jsonl(...records: Record<string, unknown>[]): string {
  return records.map((row) => JSON.stringify(row)).join('\n');
}
function selection(): ComparisonSelection {
  return {
    repository: 'example/repo', run: '999', attempt: '2', runNumber: 8, pullNumber: 3,
    sourceWorkflow: '.github/workflows/skill-evals.yml', sourceRun: '123', sourceAttempt: '1',
    workflowRef: 'example/repo/.github/workflows/compare.yml@refs/heads/main',
    trusted: 'd'.repeat(40), base: 'a'.repeat(40), head: 'b'.repeat(40),
    merge: 'c'.repeat(40), runHead: 'b'.repeat(40), changed: ['local/draft'],
    skills: [{ key: 'local/draft', hasEval: true }, { key: 'local/neighbor', hasEval: true },
      { key: 'remote/run', hasEval: false }],
    include: [{ key: 'local/draft', id: 'skill-aaaaaaaaaaaa', directory: 'plugins/local/skills/draft',
      evalPath, base: 'a'.repeat(40), head: 'b'.repeat(40) }],
  };
}
function pair(): ComparisonPair & { before: ComparisonArm; after: ComparisonArm } {
  return {
    key: 'local/draft',
    before: collectNative(jsonl(trial(), footer()), 'native', 1),
    after: collectNative(jsonl(trial({ gradeResult: grade(true) }),
      footer({ passed: true }, { passed: true })), 'native', 0),
  };
}
const evidence = 'https://github.com/example/repo/actions/runs/999';

async function save(root: string, selected = selection(), sample = pair()): Promise<void> {
  await writeFile(join(root, 'selection.json'), JSON.stringify(selected));
  for (const arm of ['before', 'after'] as const) {
    await writeFile(join(root, `${selected.include[0]!.id}-${arm}.json`), JSON.stringify({
      id: selected.include[0]!.id, key: sample.key, arm, repository: selected.repository,
      run: selected.run, attempt: selected.attempt, merge: selected.merge, data: sample[arm],
    }));
  }
}
async function saveArm(root: string, data: unknown, overrides: Record<string, unknown> = {}): Promise<void> {
  const selected = selection();
  await writeFile(join(root, `${selected.include[0]!.id}-after.json`), JSON.stringify({
    id: selected.include[0]!.id, key: 'local/draft', arm: 'after', repository: selected.repository,
    run: selected.run, attempt: selected.attempt, merge: selected.merge, data, ...overrides,
  }));
}

describe('native comparison projection', () => {
  it('uses the real native schema, retains individual counts, and drops private evidence', () => {
    const source = jsonl(trial(), footer());
    expect(parseNativeEvidence(source, 'native', 1).outcome).toBe('failed');
    const data = collectNative(source, 'native', 1);
    expect(data.state).toBe('complete');
    expect(data.rows[0]).toMatchObject({ eval: 'draft', stimulus: 'draft-positive', model: 'model-a',
      state: 'graded', passed: false });
    expect(data.rows[0]!.checks.map((check) => check.passed)).toEqual([true, false]);
    expect(data.rows[0]!.checks[1]!.reason).toMatch(/activation/);
    expect(JSON.stringify(data)).not.toMatch(/SECRET|trajectory|evalFilePath|score|evidence/);
  });

  it('requires the native identity, trajectory and finite scores before projecting', () => {
    for (const change of [
      { runId: 'other' }, { itemId: undefined }, { trajectory: { output: 'SECRET' } },
      { gradeResult: { passed: true } }, { gradeResult: { passed: true, score: 'SECRET' } },
    ]) expect(() => collectNative(jsonl(trial(change), footer()), 'native', 1)).toThrow();
    expect(() => collectNative(jsonl(trial(), footer()), 'other', 1)).toThrow();
    expect(() => collectNative('SECRET_INVALID_JSON', 'native', 1)).toThrow('malformed-native-jsonl');
    expect(collectNative('', 'native', null)).toEqual({ state: 'error', rows: [] });
  });

  it('requires exactly one trial per case/model and individual grader details', () => {
    expect(() => collectNative(jsonl(trial(), trial({ itemId: 'retry' }), footer()), 'native', 1))
      .toThrow(/one trial per case\/model/);
    expect(() => collectNative(jsonl(trial({ gradeResult: { passed: true, score: 1 } }), footer()), 'native', 1))
      .toThrow(/individual grader evidence/);
    expect(() => collectNative(jsonl(trial({ gradeResult: { passed: true, score: 1, details: [] } }), footer()), 'native', 1))
      .toThrow(/individual grader evidence/);
    expect(() => collectNative(jsonl(trial({ model: undefined }), footer()), 'native', 1)).toThrow();
    expect(() => collectNative(jsonl(trial({ gradeResult: grade(), variant: '' }), footer({ variant: '' })), 'native', 1))
      .toThrow(/label/);
  });

  it('requires complete native coverage and a supported actual process exit', () => {
    const partial = collectNative(jsonl(trial(), footer({ stimuliTotal: 2 })), 'native', 1);
    expect(partial.state).toBe('error');
    expect(partial.rows[0]!.checks[1]!.passed).toBe(false);
    for (const group of [{ hadExecutionErrors: true }, { hadGradingErrors: true }]) {
      expect(collectNative(jsonl(trial(), footer(group)), 'native', 1).state).toBe('error');
    }
    for (const exit of [2, 137, null]) {
      expect(collectNative(jsonl(trial(), footer()), 'native', exit).state).toBe('error');
    }
    expect(collectNative(jsonl(trial({ gradeResult: grade(true) }),
      footer({ passed: true }, { passed: true })), 'native', 1).state).toBe('error');
    expect(() => collectNative(jsonl(trial(), footer({ model: 'wrong' })), 'native', 1)).toThrow();
    expect(collectNative(jsonl(footer({}, { evals: [], passed: true })), 'native', 0))
      .toEqual({ state: 'not-run', nativeOutcome: 'not-run', rows: [] });
    expect(collectNative(jsonl(footer({ stimuliRun: 0, stimuliTotal: 1 })), 'native', 1).state).toBe('error');
  });

  it('preserves completed failing graders alongside grading and trajectory errors', () => {
    const data = collectNative(jsonl(trial({ gradeResult: { passed: false, score: 0, details: [
      { graderType: 'completed', passed: false, score: 0 },
      { graderType: 'program', passed: false, score: 0, status: 'error', reason: 'SECRET' },
    ] } }), footer({}, { hadExecutionErrors: true })), 'native', 1);
    expect(data.state).toBe('error');
    expect(data.rows[0]!.state).toBe('error');
    expect(data.rows[0]!.checks).toEqual([{ id: '0:completed', name: 'completed', passed: false,
      reason: 'The session did not meet its completion checks.' }]);
    const sample = pair();
    sample.after = data;
    const rendered = renderComparison(selection(), [sample], evidence);
    expect(rendered).toContain('After failures in changed skills (1 grader/model results)');
    expect(rendered).toContain('After (comparison unknown) | completed');
    expect(rendered).not.toContain('SECRET');
    const trajectoryError = collectNative(jsonl(trial({
      trajectory: { id: 't', output: 'SECRET', events: [{ type: 'error', message: 'SECRET' }] },
    }), footer()), 'native', 1);
    expect(trajectoryError.state).toBe('error');
    expect(trajectoryError.rows[0]!.checks).toHaveLength(2);
  });

  it('does not turn skipped or ungraded native trials into passes', () => {
    const skipped = collectNative(jsonl(trial({ status: 'skipped', gradeResult: null }),
      footer({ stimuliRun: 0, stimuliSkipped: 1 })), 'native', 1);
    expect(skipped.rows[0]).toMatchObject({ state: 'not-run', passed: false, checks: [] });
    const ungraded = collectNative(jsonl(trial({ gradeResult: null }), footer()), 'native', 1);
    expect(ungraded.state).toBe('error');
    expect(ungraded.rows[0]).toMatchObject({ state: 'error', passed: false, checks: [] });
    const variant = collectNative(jsonl(trial({ variant: 'variant-b' }), footer({ variant: 'variant-b' })), 'native', 1);
    expect(variant.rows[0]!.model).toBe('model-a / variant-b');
  });

  it('keeps native scoring separate from individual checks and uses generic unknown-grader reasons', () => {
    const data = collectNative(jsonl(trial({ gradeResult: {
      passed: true, score: 0.5, details: [
        { graderType: 'custom-check', name: 'contract', passed: false, score: 0, reason: 'SECRET' },
        { graderType: 'completed', passed: true, score: 1 },
      ],
    } }), footer({ scoringApplied: true, overallScore: 0.5, threshold: 0.5, passed: true }, { passed: true })), 'native', 0);
    expect(data.rows[0]!.passed).toBe(true);
    expect(data.rows[0]!.checks[0]!.reason).toBe('The configured check failed.');
    const report = renderComparison(selection(), [{ key: 'local/draft', before: data, after: data }], evidence);
    expect(report).toContain('1/2 → 1/2');
    expect(report).toContain('local/draft | 1/1 → 1/1');
    expect(report).not.toContain('SECRET');
  });

  it('preserves native threshold rejection even when every individual grader passes', async () => {
    const checked = trial({ gradeResult: { passed: true, score: 0.5, details: [
      { graderType: 'completed', passed: true, score: 0.5 },
    ] } });
    const failed = collectNative(jsonl(checked, footer({
      scoringApplied: true, overallScore: 0.5, threshold: 0.8, passed: false,
    }, { passed: false })), 'native', 1);
    expect(failed).toMatchObject({ state: 'complete', nativeOutcome: 'failed',
      rows: [{ state: 'graded', passed: true, nativePassed: false }] });
    const sample = { key: 'local/draft', before: failed, after: failed };
    const rendered = renderComparison(selection(), [sample], evidence);
    expect(rendered).toContain('Native verdicts:** Before ❌ Failed → After ❌ Failed');
    expect(rendered).toContain('1/1 (native eval failed)');
    expect(rendered).not.toContain('✅ 1/1 → 1/1');
    const root = await directory();
    await save(root, selection(), sample);
    const loaded = await loadComparison(root, selection());
    expect(loaded.pairs[0]!.after).toEqual(failed);
  });

  it('recognizes nested grader errors without discarding other completed grader failures', () => {
    const data = collectNative(jsonl(trial({ gradeResult: {
      passed: false, score: 0, details: [
        { graderType: 'completed', passed: false, score: 0 },
        { graderType: 'program', passed: false, score: 0, details: [
          { passed: false, score: 0, status: 'error', reason: 'SECRET' },
        ] },
      ],
    } }), footer()), 'native', 1);
    expect(data.state).toBe('error');
    expect(data.rows[0]!.checks.map((check) => check.id)).toEqual(['0:completed']);
  });
});

describe('comparison renderer', () => {
  it('compresses only unmeasured unchanged inventory to publish a valid thousand-skill catalog', () => {
    const selected = selection();
    selected.skills = [selected.skills[0]!, ...Array.from({ length: 999 }, (_, index) => ({
      key: `plugin-${index}/unchanged-skill-without-measurements-${index}`, hasEval: index % 2 === 0,
    }))];
    const sample = pair();
    sample.after.nativeOutcome = 'failed';
    sample.after.rows[0]!.nativePassed = false;
    sample.after.rows[0]!.passed = false;
    sample.after.rows[0]!.checks[0]!.passed = false;
    const report = renderComparison(selected, [sample], evidence);
    expect(Buffer.byteLength(report)).toBeLessThanOrEqual(60_000);
    expect(report).toContain('999 unchanged skills without results summarized');
    expect(report).toContain('Changed skills and recorded results are retained');
    expect(report).toContain('## Changed skill: local/draft');
    expect(report).toContain('| local/draft |');
    expect(report).toContain('After (new) | completed');
    expect(report).toContain('Before (resolved After) | routing');
    expect(report).not.toContain('| plugin-998/');
    const inventoryTable = report.slice(report.indexOf('| Skill (passing / total scenarios) |')).split('\n\n')[0]!;
    expect(inventoryTable).toContain('| Unmeasured unchanged inventory |');
    expect(inventoryTable).toContain('| local/draft |');
  });

  it('reserves the actual publisher prefix when a body fits but the complete comment would exceed the budget', () => {
    const selected = selection();
    selected.skills = [selected.skills[0]!, ...Array.from({ length: 300 }, (_, index) => ({
      key: `catalog/skill${index}`, hasEval: true,
    }))];
    const sample = pair();
    const initialBytes = Buffer.byteLength(renderComparison(selected, [sample], evidence));
    let remaining = 59_999 - initialBytes;
    expect(remaining).toBeGreaterThan(0);
    for (const skill of selected.skills.slice(1)) {
      const padding = Math.min(remaining, 200);
      skill.key += 'x'.repeat(padding);
      remaining -= padding;
    }
    expect(remaining).toBe(0);
    const report = renderComparison(selected, [sample], evidence);
    const prefix = `<!-- evals-comparison:${selected.repository}/${selected.sourceWorkflow}/${sha256(selected.workflowRef)} -->\n<!-- run:${selected.runNumber}:${Number(selected.attempt)} -->\n`;
    expect(Buffer.byteLength(prefix + report)).toBeLessThanOrEqual(60_000);
    expect(report).toContain('300 unchanged skills without results summarized');
    expect(report).toContain('| local/draft |');
  });

  it('does not label a passing model as native-failed because another model failed', () => {
    const sample = pair();
    sample.before = structuredClone(sample.after);
    for (const arm of [sample.before, sample.after]) {
      arm.nativeOutcome = 'failed';
      const passing = { ...structuredClone(arm.rows[0]!), model: 'model-a', passed: true, nativePassed: true };
      arm.rows = [passing, { ...structuredClone(passing), model: 'model-b', nativePassed: false }];
    }
    const report = renderComparison(selection(), [sample], evidence);
    expect(report).toContain('Native verdicts:** Before ❌ Failed → After ❌ Failed');
    expect(report).toContain('| local/draft | 1/1 → 1/1 | 1/1 (native eval failed) → 1/1 (native eval failed) |');
  });
  it('retains fixed safe validation codes for report limits and coverage mismatches', async () => {
    const sample = pair();
    expect(() => renderComparison(selection(), [sample, sample], evidence)).toThrow(expect.objectContaining({
      code: 'comparison-duplicate-skill', message: 'Duplicate comparison skill.',
    }));
    const root = await directory();
    await save(root);
    await expect(loadComparison(root, { ...selection(), include: [] })).rejects.toMatchObject({
      code: 'comparison-coverage-mismatch', message: 'Artifact coverage differs from trusted selection.',
    });
  });
  it('does not resolve a different named grader at the same index and type', () => {
    const sample = pair();
    sample.before.rows[0]!.checks = [{ id: '0:program', name: 'contract-A', passed: false, reason: '' }];
    sample.after.rows[0]!.checks = [{ id: '0:program', name: 'contract-B', passed: true, reason: '' }];
    const rendered = renderComparison(selection(), [sample], evidence);
    expect(rendered).toContain('0 resolved · 📉 0 new failures');
    expect(rendered).toContain('Before (comparison unknown) | contract-A');
    expect(rendered).not.toContain('resolved After');
  });

  it('keeps native verdicts unknown for legacy projections and rejects malformed native fields', async () => {
    const sample = pair();
    for (const arm of [sample.before, sample.after]) {
      delete arm.nativeOutcome;
      for (const row of arm.rows) delete row.nativePassed;
    }
    const rendered = renderComparison(selection(), [sample], evidence);
    expect(rendered).toContain('Native verdicts:** Before ❔ Unknown → After ❔ Unknown');
    const root = await directory();
    await save(root, selection(), sample);
    await saveArm(root, { ...sample.after, nativeOutcome: ['passed'] });
    await expect(loadComparison(root, selection())).rejects.toThrow('native verdict');
  });
  it('renders the approved hierarchy, grader denominators, and scenario denominators without a passing wall', () => {
    const report = renderComparison(selection(), [pair()], evidence);
    expect(report).toContain('draft : positive | 📈 1/2 → 2/2');
    expect(report).toContain('passing / total graders');
    expect(report).toContain('local/draft | 0/1 → 1/1');
    expect(report).toContain('passing scenarios / total recorded scenarios');
    expect(report).toContain('Before (resolved After) | routing');
    expect(report).not.toContain('| completed |');
    expect(report).toContain('local/neighbor | ⏭️ Not run');
    expect(report).toContain('remote/run | ⏭️ Not evaluated — no repo eval');
    expect(report).toContain('does not measure unchanged-skill regressions');
    expect(report.indexOf('After failures')).toBeLessThan(report.indexOf('<details>'));
    expect(report.indexOf('Before failures')).toBeLessThan(report.indexOf('All skills'));
    expect(report.indexOf('All skills')).toBeLessThan(report.indexOf('All-skill failure details'));
    expect(report.match(/<details>/g)).toHaveLength(3);
    expect(report).not.toContain('SECRET');
  });

  it('shows changed individual failure identities even when aggregate counts are equal', () => {
    const sample = pair();
    sample.after.rows[0]!.passed = false;
    sample.after.rows[0]!.checks[0]!.passed = false;
    const report = renderComparison(selection(), [sample], evidence);
    expect(report).toContain('🔄 1/2 → 1/2');
    expect(report).toContain('🔄 0/1 → 0/1 (1 new, 1 resolved grader failures)');
    expect(report).toContain('After (new) | completed');
    expect(report).toContain('Before (resolved After) | routing');
  });

  it.each(['error', 'missing-arm', 'missing-check', 'missing-case', 'skipped'] as const)(
    'does not claim resolved/new failures with %s coverage', (change) => {
      const sample: ComparisonPair = pair();
      if (change === 'error') sample.after!.state = 'error';
      if (change === 'missing-arm') delete sample.after;
      if (change === 'missing-check') sample.after!.rows[0]!.checks.pop();
      if (change === 'missing-case') sample.before!.rows.push({
        ...structuredClone(sample.before!.rows[0]!), stimulus: 'extra',
      });
      if (change === 'skipped') sample.after!.rows[0] = {
        ...sample.after!.rows[0]!, state: 'not-run', passed: false, checks: [],
      };
      const report = renderComparison(selection(), [sample], evidence);
      expect(report).toContain('0 resolved · 📉 0 new failures');
      expect(report).toContain('comparison unknown');
      expect(report).toContain('Incomplete/error evidence');
      expect(report).not.toMatch(/resolved After|After \(new\)|📈 1\/2/);
    },
  );

  it('renders no-evidence outcomes honestly', () => {
    expect(renderComparison(selection(), [], evidence)).toContain('⏭️ Not run — an existing skill');
    const report = renderComparison(selection(), [{ key: 'local/draft', before: { state: 'error', rows: [] },
      after: { state: 'not-run', rows: [] } }], evidence);
    expect(report).toContain('Evidence unavailable');
    expect(report).toContain('⚠️ Error → ⏭️ Not run');
    expect(report).toContain('Model not observed');
  });

  it('escapes every publisher label and re-derives reasons, equally for projected and loaded inputs', async () => {
    const sample = pair();
    const hostile = '<img src=x>|`[x](javascript:x) @team **bold**\n# heading\u001b[31m\u202e';
    for (const arm of [sample.before, sample.after]) for (const row of arm.rows) {
      row.eval = hostile; row.stimulus = hostile; row.model = hostile;
      row.checks[1]!.name = hostile; row.checks[1]!.reason = 'SECRET_RAW_EXCEPTION';
    }
    const selected = selection();
    const report = renderComparison(selected, [sample], `${evidence}?query=(x)`);
    expect(report).not.toMatch(/<img|@team|\*\*bold\*\*|SECRET/);
    expect(report).not.toContain('\u001b');
    expect(report).not.toContain('\u202e');
    expect(report).toContain('&#60;img src=x&#62;&#124;&#96;&#91;');
    expect(report).toContain('query=%28x%29');
    const root = await directory();
    await save(root, selected, sample);
    const loaded = await loadComparison(root, selected);
    expect(loaded.pairs[0]!.before!.rows[0]!.eval).toBe(hostile);
    expect(renderComparison(loaded.selection, loaded.pairs, `${evidence}?query=(x)`)).toBe(report);
    expect(report).not.toContain('&#38;#60;');
    for (const url of ['javascript:alert(1)', 'http://example.test', 'https://user:SECRET@example.test']) {
      expect(() => renderComparison(selected, [sample], url)).toThrow(/HTTPS/);
    }
  });

  it('rejects oversized reports instead of silently truncating failures', () => {
    const sample = pair();
    sample.after.nativeOutcome = 'failed';
    for (const arm of [sample.before, sample.after]) {
      arm.rows = Array.from({ length: 300 }, (_, index) => ({
        ...structuredClone(sample.before.rows[0]!), stimulus: `case-${index}`,
      }));
    }
    expect(() => renderComparison(selection(), [sample], evidence)).toThrow(/comment limit/);
  });
});

describe('comparison artifact intake', () => {
  it('loads exact selection and artifact identities, allowing selection structural extras', async () => {
    const root = await directory();
    const selected = { ...selection(), extraContext: { approved: true } };
    const sample = pair();
    await save(root, selected, sample);
    const loaded = await loadComparison(root, selected);
    expect(loaded.selection).toEqual(selected);
    expect(loaded.pairs).toEqual([sample]);
  });

  it.each(['repository', 'run', 'attempt', 'merge', 'key', 'id', 'arm'])('rejects a mixed %s artifact', async (field) => {
    const root = await directory();
    await save(root);
    await saveArm(root, pair().after, { [field]: 'wrong' });
    await expect(loadComparison(root, selection())).rejects.toThrow(/Mixed comparison artifacts/);
  });

  it('compares the entire selection, including coverage and context extras, not a subset', async () => {
    const root = await directory();
    await save(root);
    for (const selected of [
      { ...selection(), changed: [] }, { ...selection(), sourceAttempt: '2' },
      { ...selection(), skills: [] }, { ...selection(), untrustedExtra: true },
    ]) await expect(loadComparison(root, selected)).rejects.toThrow(/differs from trusted selection/);
  });

  it('marks only absent files as error arms; malformed or oversized files fail closed without excerpts', async () => {
    const root = await directory();
    await save(root);
    const file = join(root, 'skill-aaaaaaaaaaaa-after.json');
    await rm(file);
    expect((await loadComparison(root, selection())).pairs[0]!.after).toEqual({ state: 'error', rows: [] });
    await writeFile(file, 'SECRET_RAW_INVALID_JSON');
    await expect(loadComparison(root, selection())).rejects.toThrow('Malformed comparison JSON input.');
    await writeFile(file, Buffer.from([0x22, 0xc0, 0xaf, 0x22]));
    await expect(loadComparison(root, selection())).rejects.toThrow('Malformed comparison UTF-8 input.');
    await writeFile(file, ' '.repeat(1024 * 1024 + 1));
    await expect(loadComparison(root, selection())).rejects.toThrow(/bounded regular/);
    await rm(file);
    await mkdir(file);
    await expect(loadComparison(root, selection())).rejects.toThrow(/bounded regular/);
  });

  it('rejects artifact path traversal and symlinked evidence', async () => {
    const root = await directory();
    const selected = selection();
    selected.include[0]!.id = '..\\escape';
    await writeFile(join(root, 'selection.json'), JSON.stringify(selected));
    await expect(loadComparison(root, selected)).rejects.toThrow(/artifact identity/);
    await save(root);
    const file = join(root, 'skill-aaaaaaaaaaaa-after.json');
    await rm(file);
    // Directory junctions work on Windows without the privilege required by file symlinks.
    await symlink(root, file, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(loadComparison(root, selection())).rejects.toThrow(/bounded regular/);
  });

  it.each([
    (data: ComparisonArm) => ({ ...data, state: 'passed' }),
    (data: ComparisonArm) => ({ ...data, state: ['complete'] }),
    (data: ComparisonArm) => ({ ...data, rawOutput: 'SECRET' }),
    (data: ComparisonArm) => ({ ...data, rows: [data.rows[0], data.rows[0]] }),
    (data: ComparisonArm) => ({ ...data, rows: [{ ...data.rows[0], state: 'error', passed: true }] }),
    (data: ComparisonArm) => ({ ...data, rows: [{ ...data.rows[0], state: 'graded', checks: [] }] }),
    (data: ComparisonArm) => ({ ...data, rows: [{ ...data.rows[0], eval: '' }] }),
    (data: ComparisonArm) => ({ ...data, rows: [{ ...data.rows[0], checks: [
      data.rows[0]!.checks[0], data.rows[0]!.checks[0],
    ] }] }),
    (data: ComparisonArm) => ({ ...data, rows: [{ ...data.rows[0], checks: [
      { ...data.rows[0]!.checks[0], id: '0:completed' }, { ...data.rows[0]!.checks[1], id: '0:program' },
    ] }] }),
    (data: ComparisonArm) => ({ ...data, rows: [{ ...data.rows[0], checks: [
      { ...data.rows[0]!.checks[0], passed: 'true' },
    ] }] }),
    (data: ComparisonArm) => ({ ...data, state: 'complete', rows: [] }),
    (data: ComparisonArm) => ({ ...data, state: 'not-run' }),
  ])('rejects unsafe projected schemas #%#', async (change) => {
    const root = await directory();
    await save(root);
    await saveArm(root, change(pair().after));
    await expect(loadComparison(root, selection())).rejects.toThrow();
  });
});

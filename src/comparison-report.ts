import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';
import { ComparisonError, type ComparisonSelection } from './comparison-context.js';
import { parseNativeEvidence } from './native.js';
import { sha256 } from './tooling.js';

export type { ComparisonSelection } from './comparison-context.js';

export interface ComparisonCheck {
  id: string;
  name: string;
  passed: boolean;
  reason: string;
}

export interface ComparisonRow {
  eval: string;
  stimulus: string;
  model: string;
  state: 'graded' | 'error' | 'not-run';
  passed: boolean;
  nativePassed?: boolean;
  checks: ComparisonCheck[];
}

export interface ComparisonArm {
  state: 'complete' | 'error' | 'not-run';
  nativeOutcome?: 'passed' | 'failed' | 'error' | 'not-run' | 'cancelled' | 'unknown';
  rows: ComparisonRow[];
}

export interface ComparisonPair {
  key: string;
  before?: ComparisonArm;
  after?: ComparisonArm;
}

const maxArtifactBytes = 1024 * 1024;
const maxRows = 10_000;
const maxChecks = 1_000;
const maxLabel = 256;
const arms = ['before', 'after'] as const;
type ArmName = typeof arms[number];
type RecordValue = Record<string, unknown>;

function invalid(code: string, message: string): never { throw new ComparisonError(code, message); }

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('comparison-invalid-object', 'Invalid comparison object.');
  return value as RecordValue;
}

function exact(value: RecordValue, keys: string[], optional: string[] = []): void {
  if (Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    invalid('comparison-unexpected-fields', 'Unexpected comparison fields.');
  }
}

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLabel) invalid('comparison-invalid-label', 'Invalid comparison label.');
  return value;
}

function failedReason(type: string): string {
  const reasons: Record<string, string> = {
    'skill-invocation': 'Required activation was missing or a disallowed skill activated.',
    program: 'The configured output/workspace contract was not satisfied.',
    'diff-empty': 'The workspace changed when it should have stayed unchanged.',
    'output-matches': 'The answer did not match the configured output check.',
    'file-matches': 'A file did not match its configured check.',
    'tool-calls': 'Required tool use was missing or a disallowed tool was used.',
    completed: 'The session did not meet its completion checks.',
  };
  return Object.hasOwn(reasons, type) ? reasons[type]! : 'The configured check failed.';
}

function checkReason(check: Pick<ComparisonCheck, 'id' | 'passed'>): string {
  return check.passed ? '' : failedReason(check.id.slice(check.id.indexOf(':') + 1));
}

function rowIdentity(row: Pick<ComparisonRow, 'eval' | 'stimulus' | 'model'>): string {
  return JSON.stringify([row.eval, row.stimulus, row.model]);
}

function groupIdentity(row: RecordValue): string {
  return JSON.stringify([row.evalFilePath, row.variant, row.model ?? '']);
}

function gradeError(grade: RecordValue): boolean {
  const pending = [grade];
  while (pending.length) {
    const check = pending.pop()!;
    if (check.status === 'error') return true;
    if (Array.isArray(check.details)) for (const item of check.details) pending.push(record(item));
  }
  return false;
}

/** Project only case identifiers and individual verdicts, never native output or exceptions. */
export function collectNative(contents: string, runId: string, exitCode: number | null): ComparisonArm {
  if (Buffer.byteLength(contents) > 64 * 1024 * 1024) invalid('comparison-native-evidence-too-large', 'Native comparison evidence exceeds its size limit.');
  if (!contents.trim()) return { state: 'error', rows: [] };
  const native = parseNativeEvidence(contents, runId, exitCode);
  // parseNativeEvidence owns source JSONL/schema validation; comparison adds coverage requirements.
  const records = contents.split(/\r?\n/).filter((line) => line.trim()).map((line) => record(JSON.parse(line)));
  const summary = records.at(-1)!;
  const groups = summary.evals as RecordValue[];
  const nativeVerdicts = new Map(groups.map((group) => {
    if (typeof group.passed !== 'boolean') invalid('comparison-invalid-native-verdict', 'Invalid native eval verdict.');
    return [groupIdentity(group), group.passed] as const;
  }));
  const identities = new Set<string>();
  const observed = new Map<string, { run: number; skipped: number }>();
  const rows = records.slice(0, -1).map((trial): ComparisonRow => {
    const evalName = label(trial.evalName);
    const stimulus = label(trial.stimulus);
    const model = label(trial.model);
    const variant = label(trial.variant);
    const displayModel = label(variant === 'main' ? model : `${model} / ${variant}`);
    const identity = rowIdentity({ eval: evalName, stimulus, model: displayModel });
    if (identities.has(identity)) invalid('comparison-duplicate-native-trial', 'Expected one trial per case/model, without retries.');
    identities.add(identity);
    const bucket = observed.get(groupIdentity(trial)) ?? { run: 0, skipped: 0 };
    if (trial.status === 'skipped') bucket.skipped++;
    else bucket.run++;
    observed.set(groupIdentity(trial), bucket);
    const grade = trial.gradeResult == null ? undefined : record(trial.gradeResult);
    const trajectory = trial.trajectory == null ? undefined : record(trial.trajectory);
    const executionError = Array.isArray(trajectory?.events) &&
      trajectory.events.some((event) => record(event).type === 'error');
    const state: ComparisonRow['state'] = trial.status === 'skipped' ? 'not-run' :
      trial.status !== 'success' || !grade || gradeError(grade) || executionError ? 'error' : 'graded';
    if (state === 'graded' && (!Array.isArray(grade?.details) || !grade.details.length)) {
      invalid('comparison-native-graders-missing', 'Native individual grader evidence is missing.');
    }
    const details = state === 'not-run' ? [] : grade?.details ?? [];
    if (!Array.isArray(details) || details.length > maxChecks) invalid('comparison-invalid-native-graders', 'Invalid native individual graders.');
    const checks: ComparisonCheck[] = details.flatMap((item, index) => {
      const check = record(item);
      if (gradeError(check)) return [];
      if (typeof check.passed !== 'boolean') invalid('comparison-invalid-native-grader-verdict', 'Invalid native grader verdict.');
      const type = check.graderType ?? check.kind ?? 'check';
      if (typeof type !== 'string' || !/^[a-z0-9._-]{1,128}$/.test(type)) invalid('comparison-invalid-native-grader-type', 'Invalid native grader type.');
      const projected = { id: `${index}:${type}`, name: label(check.configuredName ?? check.name ?? type), passed: check.passed };
      return [{ ...projected, reason: checkReason(projected) }];
    });
    const nativePassed = nativeVerdicts.get(groupIdentity(trial));
    if (nativePassed === undefined) invalid('comparison-native-eval-verdict-missing', 'Missing native eval verdict.');
    return { eval: evalName, stimulus, model: displayModel, state, passed: state === 'graded' && grade?.passed === true, nativePassed, checks };
  });
  if (rows.length > maxRows) invalid('comparison-too-many-cases', 'Too many comparison cases.');
  const complete = groups.every((group) => {
    const bucket = observed.get(groupIdentity(group)) ?? { run: 0, skipped: 0 };
    return !group.hadExecutionErrors && !group.hadGradingErrors &&
      group.stimuliRun === bucket.run && (group.stimuliSkipped ?? 0) === bucket.skipped &&
      group.stimuliTotal === bucket.run + bucket.skipped;
  });
  const validExit = (exitCode === 0 || exitCode === 1) && (summary.passed !== true || exitCode === 0);
  return {
    state: complete && validExit && native.outcome !== 'error' && !rows.some((row) => row.state === 'error')
      ? rows.length ? 'complete' : 'not-run' : 'error',
    nativeOutcome: native.outcome === 'passed' || native.outcome === 'failed' || native.outcome === 'not-run' ? native.outcome : 'error',
    rows,
  };
}

function safeArm(value: unknown): ComparisonArm {
  const data = record(value);
  exact(data, ['state', 'rows'], ['nativeOutcome']);
  if (typeof data.state !== 'string' || !['complete', 'error', 'not-run'].includes(data.state) || !Array.isArray(data.rows) ||
      data.rows.length > maxRows) invalid('comparison-invalid-arm', 'Invalid comparison arm.');
  if (data.nativeOutcome !== undefined && (typeof data.nativeOutcome !== 'string' ||
      !['passed', 'failed', 'error', 'not-run', 'cancelled', 'unknown'].includes(data.nativeOutcome))) {
    invalid('comparison-invalid-native-outcome', 'Invalid comparison native verdict.');
  }
  const identities = new Set<string>();
  const rows = data.rows.map((item): ComparisonRow => {
    const row = record(item);
    exact(row, ['eval', 'stimulus', 'model', 'state', 'passed', 'checks'], ['nativePassed']);
    if (typeof row.state !== 'string' || !['graded', 'error', 'not-run'].includes(row.state) || typeof row.passed !== 'boolean' ||
        (row.state !== 'graded' && row.passed) || !Array.isArray(row.checks) || row.checks.length > maxChecks ||
        (row.nativePassed !== undefined && typeof row.nativePassed !== 'boolean')) {
      invalid('comparison-invalid-case', 'Invalid comparison case.');
    }
    const projected = { eval: label(row.eval), stimulus: label(row.stimulus), model: label(row.model) };
    const identity = rowIdentity(projected);
    if (identities.has(identity)) invalid('comparison-duplicate-case', 'Duplicate comparison case.');
    identities.add(identity);
    const checkIds = new Set<string>(), checkIndexes = new Set<string>();
    const checks = row.checks.map((item): ComparisonCheck => {
      const check = record(item);
      exact(check, ['id', 'name', 'passed', 'reason']);
      if (typeof check.id !== 'string' || !/^(0|[1-9]\d{0,3}):[a-z0-9._-]{1,128}$/.test(check.id) ||
          checkIds.has(check.id) || typeof check.passed !== 'boolean' ||
          typeof check.reason !== 'string' || check.reason.length > 4096) invalid('comparison-invalid-check', 'Invalid comparison check.');
      const index = check.id.split(':')[0]!;
      if (Number(index) >= maxChecks || checkIndexes.has(index)) invalid('comparison-invalid-check-index', 'Duplicate or invalid comparison check index.');
      checkIds.add(check.id); checkIndexes.add(index);
      const projected = { id: check.id, name: label(check.name), passed: check.passed };
      return { ...projected, reason: checkReason(projected) };
    });
    if ((row.state === 'graded' && !checks.length) || (row.state === 'not-run' && checks.length)) {
      invalid('comparison-checks-missing-or-unexpected', 'Missing or unexpected comparison checks.');
    }
    return { ...projected, state: row.state as ComparisonRow['state'], passed: row.passed,
      ...(typeof row.nativePassed === 'boolean' ? { nativePassed: row.nativePassed } : {}), checks };
  });
  if ((data.state === 'not-run' && rows.some((row) => row.state !== 'not-run')) ||
      (data.state === 'complete' && (!rows.length || rows.some((row) => row.state === 'error')))) {
    invalid('comparison-inconsistent-arm', 'Inconsistent comparison arm.');
  }
  if (data.nativeOutcome === 'passed' && rows.some((row) => row.nativePassed === false)) {
    invalid('comparison-inconsistent-native-outcome', 'Inconsistent comparison native verdict.');
  }
  return { state: data.state as ComparisonArm['state'], rows,
    ...(data.nativeOutcome !== undefined ? { nativeOutcome: data.nativeOutcome as NonNullable<ComparisonArm['nativeOutcome']> } : {}) };
}

function text(value: string): string {
  return stripVTControlCharacters(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/[&<>|`[\]@\\*_~]/g, (char) => `&#${char.codePointAt(0)};`);
}

function failures(row: ComparisonRow | undefined): Set<string> {
  return new Set(row?.checks.filter((check) => !check.passed).map((check) => check.id));
}

function difference(a: Set<string>, b: Set<string>): number { return [...a].filter((id) => !b.has(id)).length; }

function comparable(pair: ComparisonPair): boolean {
  if (pair.before?.state !== 'complete' || pair.after?.state !== 'complete' ||
      pair.before.rows.length !== pair.after.rows.length) return false;
  const afterRows = new Map(pair.after.rows.map((row) => [rowIdentity(row), row]));
  return pair.before.rows.every((before) => {
    const after = afterRows.get(rowIdentity(before));
    const afterChecks = new Map(after?.checks.map((check) => [check.id, check.name]));
    return before.state === 'graded' && after?.state === 'graded' &&
      before.checks.length === after.checks.length &&
      before.checks.every((check) => afterChecks.get(check.id) === check.name);
  });
}

function counts(arm?: ComparisonArm, row?: ComparisonRow): string {
  if (!arm || arm.state === 'error') return '⚠️ Error';
  if (arm.state === 'not-run') return '⏭️ Not run';
  if (!row) return '❔ Unknown';
  if (row.state === 'error') return '⚠️ Error';
  if (row.state === 'not-run') return '⏭️ Not run';
  const passed = row.checks.filter((check) => check.passed).length;
  return `${passed}/${row.checks.length}${passed === row.checks.length && row.nativePassed === false ? ' (native eval failed)' : ''}`;
}

function nativeVerdict(arm: ComparisonArm | undefined): string {
  return ({ passed: '✅ Passed', failed: '❌ Failed', error: '⚠️ Error', 'not-run': '⏭️ Not run',
    cancelled: '⏭️ Cancelled', unknown: '❔ Unknown' })[arm?.nativeOutcome ?? 'unknown'];
}

function delta(pair: ComparisonPair, model?: string): { added: number; resolved: number } {
  let added = 0, resolved = 0;
  const beforeRows = new Map(pair.before?.rows.map((row) => [rowIdentity(row), row]));
  if (comparable(pair)) for (const after of pair.after!.rows) {
    if (model !== undefined && after.model !== model) continue;
    const before = beforeRows.get(rowIdentity(after));
    added += difference(failures(after), failures(before));
    resolved += difference(failures(before), failures(after));
  }
  return { added, resolved };
}

function scenarios(pair: ComparisonPair): ComparisonRow[] {
  return [...new Map([...(pair.before?.rows ?? []), ...(pair.after?.rows ?? [])]
    .map((row) => [JSON.stringify([row.eval, row.stimulus]), row])).values()];
}

export function comparisonCommentMetadata(selection: ComparisonSelection): { marker: string; prefix: string } {
  const marker = `<!-- evals-comparison:${selection.repository}/${selection.sourceWorkflow}/${sha256(selection.workflowRef)} -->`;
  return { marker, prefix: `${marker}\n<!-- run:${selection.runNumber}:${Number(selection.attempt)} -->\n` };
}

function boundedAppender(lines: string[], maximumBytes: number): (...values: string[]) => void {
  let length = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, -1);
  return (...values) => {
    length += values.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    if (length > maximumBytes) invalid('comparison-comment-too-large', 'Comparison exceeds the comment limit; no truncated report published.');
    lines.push(...values);
  };
}

/** Escaping happens here, equally for freshly projected and artifact-loaded labels. */
export function renderComparison(selection: ComparisonSelection, inputPairs: ComparisonPair[], evidenceUrl: string): string {
  const maximumBytes = 60_000 - Buffer.byteLength(comparisonCommentMetadata(selection).prefix);
  const url = URL.parse(evidenceUrl);
  if (!url || evidenceUrl.length > 2048 || url.protocol !== 'https:' || url.username || url.password) {
    invalid('comparison-invalid-evidence-url', 'Expected a safe HTTPS evidence URL.');
  }
  const evidence = url.href.replace(/[()<>[\]`]/g, (char) => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`);
  const seen = new Set<string>();
  const pairs = inputPairs.map((pair): ComparisonPair => {
    label(pair.key);
    if (seen.has(pair.key)) invalid('comparison-duplicate-skill', 'Duplicate comparison skill.');
    seen.add(pair.key);
    return {
      key: pair.key,
      ...(pair.before !== undefined ? { before: safeArm(pair.before) } : {}),
      ...(pair.after !== undefined ? { after: safeArm(pair.after) } : {}),
    };
  });
  const changedPairs = pairs.filter((pair) => selection.changed.includes(pair.key));
  const comparablePairs = new Set(pairs.filter(comparable));
  const indexes = new Map<ComparisonArm, Map<string, ComparisonRow>>();
  for (const pair of pairs) for (const arm of arms) {
    const data = pair[arm];
    if (data) indexes.set(data, new Map(data.rows.map((row) => [rowIdentity(row), row])));
  }
  const findRow = (arm: ComparisonArm | undefined, row: Pick<ComparisonRow, 'eval' | 'stimulus' | 'model'>) =>
    arm ? indexes.get(arm)?.get(rowIdentity(row)) : undefined;
  const models = [...new Set(pairs.flatMap((pair) =>
    [...(pair.before?.rows ?? []), ...(pair.after?.rows ?? [])].map((row) => row.model)))].sort();
  if (!models.length) models.push('Model not observed');
  const totals = changedPairs.reduce((sum, pair) => {
    const change = delta(pair);
    return { added: sum.added + change.added, resolved: sum.resolved + change.resolved };
  }, { added: 0, resolved: 0 });
  const lines = [
    '# 🧪 Skill eval comparison', '',
    `**Changed skills:** 📈 ${totals.resolved} resolved · 📉 ${totals.added} new failures (grader/model results).`,
    `**Sources:** Before \`${text(selection.base)}\` → After \`${text(selection.head)}\` · [Evidence](${evidence})`,
    '**Trials:** One per scenario/model/arm, zero retries. Differences do not prove causation.', '',
    '**Cells: Before → After.** A scenario is one case; graders are its individual checks.', '',
  ];
  const append = boundedAppender(lines, maximumBytes);
  if (selection.changed.some((key) => !changedPairs.some((pair) => pair.key === key && comparablePairs.has(pair)))) {
    append('**⚠️ Incomplete/error evidence:** affected cells are not passing results. Check the linked workflow.', '');
  }
  for (const skill of selection.changed) {
    const pair = changedPairs.find((item) => item.key === skill);
    append(`## Changed skill: ${text(skill)}`, '');
    if (!pair) {
      append('⏭️ Not run — an existing skill in both revisions and its repo eval are required.', '');
      continue;
    }
    append(`**Native verdicts:** Before ${nativeVerdict(pair.before)} → After ${nativeVerdict(pair.after)}.`, '');
    append(`| Eval : scenario (passing / total graders) | ${models.map(text).join(' | ')} |`,
      `| --- | ${models.map(() => '---').join(' | ')} |`);
    const rows = scenarios(pair);
    for (const row of rows) {
      const cells = models.map((model) => {
        const identity = { ...row, model };
        const before = findRow(pair.before, identity), after = findRow(pair.after, identity);
        const old = failures(before), current = failures(after);
        const added = difference(current, old), resolved = difference(old, current);
        const known = comparablePairs.has(pair) && before && after;
        const nativePass = pair.before?.nativeOutcome === 'passed' && pair.after?.nativeOutcome === 'passed' &&
          before?.nativePassed === true && after?.nativePassed === true;
        const icon = !known ? '' : added && resolved ? '🔄 ' : added ? '📉 ' : resolved ? '📈 ' :
          current.size || before?.nativePassed === false || after?.nativePassed === false ? '❌ ' : nativePass ? '✅ ' : '';
        return `${icon}${counts(pair.before, before)} → ${counts(pair.after, after)}${known ? '' : ' (comparison unknown)'}`;
      });
      const short = row.stimulus.startsWith(`${row.eval}-`) ? row.stimulus.slice(row.eval.length + 1) : row.stimulus;
      append(`| ${text(row.eval)} : ${text(short)} | ${cells.join(' | ')} |`);
    }
    if (!rows.length) append(`| Evidence unavailable | ${models.map(() =>
      `${counts(pair.before)} → ${counts(pair.after)}`).join(' | ')} |`);
    append('');
  }
  const failureCount = (scope: ComparisonPair[], arm: ArmName) => scope.reduce((sum, pair) =>
    sum + (pair[arm]?.rows ?? []).reduce((total, row) => total + failures(row).size, 0), 0);
  const detailLines = (scope: ComparisonPair[], selectedArms: readonly ArmName[]): string[] => {
    const output: string[] = [];
    const emit = boundedAppender(output, maximumBytes);
    for (const pair of scope) {
      const entries = selectedArms.flatMap((arm) => (pair[arm]?.rows ?? []).flatMap((row) =>
        row.checks.filter((check) => !check.passed).map((check) => ({ arm, row, check }))));
      if (!entries.length) continue;
      emit(`### Skill: ${text(pair.key)}`, '');
      for (const identity of scenarios(pair)) {
        const rows = entries.filter(({ row }) => row.eval === identity.eval && row.stimulus === identity.stimulus);
        if (!rows.length) continue;
        emit(`**Eval : scenario:** ${text(identity.eval)} : ${text(identity.stimulus)}`, '',
          '| Change | Failed grader | Model | Why it failed | Evidence |', '| --- | --- | --- | --- | --- |');
        for (const { arm, row, check } of rows) {
          const other = findRow(pair[arm === 'before' ? 'after' : 'before'], row);
          const otherFailed = failures(other).has(check.id);
          const change = !comparablePairs.has(pair) ? 'comparison unknown' : arm === 'after'
            ? otherFailed ? 'already present' : 'new' : otherFailed ? 'persists After' : 'resolved After';
          emit(`| ${arm === 'after' ? 'After' : 'Before'} (${change}) | ${text(check.name)} | ${text(row.model)} | ${checkReason(check)} | [Native run](${evidence}) |`);
        }
        emit('');
      }
    }
    return output.length ? output : ['No recorded failed graders. Missing/error results are not passes.', ''];
  };
  append(`## ❌ After failures in changed skills (${failureCount(changedPairs, 'after')} grader/model results)`, '',
    ...detailLines(changedPairs, ['after']), '<details>',
    `<summary>🕰️ Before failures in changed skills: ${failureCount(changedPairs, 'before')} grader/model results</summary>`, '',
    ...detailLines(changedPairs, ['before']), '</details>', '');
  const evaluated = selection.skills.filter((skill) => pairs.some((pair) => pair.key === skill.key &&
    ((pair.before?.rows.length ?? 0) + (pair.after?.rows.length ?? 0) > 0))).length;
  const inventoryHeader = ['<details>', `<summary>🌐 All skills: ${evaluated} with results · ${selection.skills.length - evaluated} not evaluated</summary>`, '',
    '**Cells: passing scenarios / total recorded scenarios, Before → After.** Per-trial grades determine these counts; native eval/arm verdicts are separate and can reject weighted scoring. Errors and missing results never pass.',
    'Only selected changed skills were evaluated. This run does not measure unchanged-skill regressions.', '',
    `| Skill (passing / total scenarios) | ${models.map(text).join(' | ')} |`, `| --- | ${models.map(() => '---').join(' | ')} |`];
  const inventoryRows: { line: string; required: boolean; hasEval: boolean }[] = [];
  for (const skill of selection.skills) {
    const pair = pairs.find((item) => item.key === skill.key);
    const cells = models.map((model) => {
      if (!pair) return skill.hasEval ? '⏭️ Not run — unchanged/unpaired skill' : '⏭️ Not evaluated — no repo eval';
      const values = arms.map((arm) => {
        const data = pair[arm], rows = data?.rows.filter((row) => row.model === model) ?? [];
        if (data?.state !== 'complete') return data?.state === 'not-run' ? '⏭️ Not run' : '⚠️ Error / incomplete';
        if (!rows.length) return '❔ Unknown';
        if (rows.some((row) => row.state !== 'graded')) return '⚠️ Partial / not run';
        return `${rows.filter((row) => row.passed).length}/${rows.length}${
          rows.every((row) => row.passed) && rows.some((row) => row.nativePassed === false)
            ? ' (native eval failed)' : ''}`;
      }).join(' → ');
      if (!comparablePairs.has(pair)) return `${values} (comparison unknown)`;
      const { added, resolved } = delta(pair, model);
      return added && resolved ? `🔄 ${values} (${added} new, ${resolved} resolved grader failures)` : values;
    });
    inventoryRows.push({ line: `| ${text(skill.key)} | ${cells.join(' | ')} |`,
      required: pair !== undefined || selection.changed.includes(skill.key), hasEval: skill.hasEval });
  }
  const footer = ['', '<details>',
    `<summary>🔎 All-skill failure details: ${failureCount(pairs, 'after')} After · ${failureCount(pairs, 'before')} Before (grader/model results)</summary>`, '',
    ...detailLines(pairs, arms), '</details>', '', '</details>', '',
    '✅ Both pass · 📈 Failures resolved · 📉 New failures · 🔄 Both new and resolved · ❌ Existing failure.',
    '⚠️ Error · ⏭️ Not run · ❔ Unknown never count as passing. Failure reasons describe checks, not raw model/grader output.', '',
    '*Each changed skill is measured separately; evals, graders, fixtures and other skill sources stay at the merge revision.*'];
  const unmeasured = inventoryRows.filter((row) => !row.required);
  const fullBytes = Buffer.byteLength([...lines, ...inventoryHeader, ...inventoryRows.map((row) => row.line), ...footer].join('\n'));
  append(...inventoryHeader);
  if (fullBytes > maximumBytes && unmeasured.length > 0) {
    const withEval = unmeasured.filter((row) => row.hasEval).length;
    append(`| Unmeasured unchanged inventory | ${models.map(() => '⏭️ Not evaluated').join(' | ')} |`,
      ...inventoryRows.filter((row) => row.required).map((row) => row.line), '',
      `**${unmeasured.length} unchanged skills without results summarized:** ${withEval} with repo evals; ${unmeasured.length - withEval} without. All remain unmeasured for every listed model. Changed skills and recorded results are retained.`, '');
  } else append(...inventoryRows.map((row) => row.line));
  append(...footer);
  const rendered = lines.join('\n');
  if (Buffer.byteLength(rendered) > maximumBytes) invalid('comparison-comment-too-large', 'Comparison exceeds the comment limit; no truncated report published.');
  return rendered;
}

async function artifact(root: string, name: string): Promise<unknown> {
  const file = resolve(root, name);
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxArtifactBytes) {
    invalid('comparison-artifact-content-invalid', 'Expected a bounded regular comparison artifact inside the download directory.');
  }
  const rel = relative(root, await realpath(file));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    invalid('comparison-artifact-content-invalid', 'Expected a bounded regular comparison artifact inside the download directory.');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxArtifactBytes || opened.ino !== metadata.ino || opened.dev !== metadata.dev) {
      invalid('comparison-artifact-changed', 'Comparison artifact changed while opening.');
    }
    const buffer = Buffer.alloc(maxArtifactBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxArtifactBytes) invalid('comparison-artifact-too-large', 'Comparison artifact exceeds its size limit.');
    let contents: string;
    try { contents = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      invalid('comparison-malformed-utf8', 'Malformed comparison UTF-8 input.');
    }
    try { return JSON.parse(contents) as unknown; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      invalid('comparison-malformed-json', 'Malformed comparison JSON input.');
    }
  } finally { await handle.close(); }
}

/** The caller authenticates provenance first; this function checks exact saved identity and safe projections. */
export async function loadComparison(
  root: string, expectedSelection: ComparisonSelection,
): Promise<{ selection: ComparisonSelection; pairs: ComparisonPair[] }> {
  const directory = await realpath(root);
  let savedSelection: unknown;
  try { savedSelection = await artifact(directory, 'selection.json'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    invalid('comparison-selection-artifact-missing', 'Missing selection.json at the artifact root; use a flat download layout with merge-multiple: true.');
  }
  if (!isDeepStrictEqual(savedSelection, expectedSelection)) invalid('comparison-coverage-mismatch', 'Artifact coverage differs from trusted selection.');
  if (expectedSelection.include.length > 1000) invalid('comparison-too-many-skills', 'Too many selected comparison skills.');
  const ids = new Set<string>(), keys = new Set<string>();
  const pairs: ComparisonPair[] = [];
  for (const entry of expectedSelection.include) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.id) || ids.has(entry.id) || keys.has(entry.key)) {
      invalid('comparison-invalid-artifact-identity', 'Invalid or duplicate comparison artifact identity.');
    }
    label(entry.key);
    ids.add(entry.id); keys.add(entry.key);
    const pair: ComparisonPair = { key: entry.key };
    for (const arm of arms) {
      let saved: unknown;
      try { saved = await artifact(directory, `${entry.id}-${arm}.json`); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        pair[arm] = { state: 'error', rows: [] };
        continue;
      }
      const value = record(saved);
      exact(value, ['id', 'key', 'arm', 'repository', 'run', 'attempt', 'merge', 'data']);
      if (value.id !== entry.id || value.key !== entry.key || value.arm !== arm ||
          value.repository !== expectedSelection.repository || value.run !== expectedSelection.run ||
          value.attempt !== expectedSelection.attempt || value.merge !== expectedSelection.merge) {
        invalid('comparison-artifact-identity-mismatch', 'Mixed comparison artifacts.');
      }
      pair[arm] = safeArm(value.data);
    }
    pairs.push(pair);
  }
  return { selection: expectedSelection, pairs };
}

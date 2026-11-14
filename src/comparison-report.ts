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
  reason?: string;
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
  const plain = stripVTControlCharacters(value);
  if (/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|bearer\s+\S+|(?:api[_-]?key|token|password)\s*[:=]\s*\S+)/i.test(plain) ||
      plain.split(/[^A-Za-z0-9]/).some((part) => part.length >= 40 && /[A-Za-z]/.test(part) && /\d/.test(part))) {
    invalid('comparison-sensitive-label', 'Comparison labels must not contain credentials.');
  }
  return value;
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
export function collectNative(contents: string, runId: string, exitCode: number | null, secrets: readonly string[] = []): ComparisonArm {
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
  const nativeNames = new Map((native.groups ?? []).map((group) => [group.identity, group.name]));
  const identities = new Set<string>();
  const observed = new Map<string, { run: number; skipped: number }>();
  const rows = records.slice(0, -1).map((trial): ComparisonRow => {
    const evalName = label(trial.evalName ?? nativeNames.get(sha256(groupIdentity(trial))));
    const stimulus = label(trial.stimulus);
    const model = trial.model === undefined || trial.model === '' ? 'Unspecified model' : label(trial.model);
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
      return [projected];
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
  const projected: ComparisonArm = {
    state: complete && validExit && native.outcome !== 'error' && !rows.some((row) => row.state === 'error')
      ? rows.length ? 'complete' : 'not-run' : 'error',
    nativeOutcome: native.outcome === 'passed' || native.outcome === 'failed' || native.outcome === 'not-run' ? native.outcome : 'error',
    rows,
  };
  const labels = rows.flatMap((row) => [row.eval, row.stimulus, row.model, ...row.checks.map((check) => check.name)]);
  if (secrets.some((secret) => secret && labels.some((value) => stripVTControlCharacters(value).includes(secret)))) {
    invalid('comparison-sensitive-label', 'Comparison labels must not contain credentials.');
  }
  return projected;
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
      exact(check, ['id', 'name', 'passed'], ['reason']);
      if (typeof check.id !== 'string' || !/^(0|[1-9]\d{0,3}):[a-z0-9._-]{1,128}$/.test(check.id) ||
          checkIds.has(check.id) || typeof check.passed !== 'boolean' ||
          (check.reason !== undefined && (typeof check.reason !== 'string' || check.reason.length > 4096))) {
        invalid('comparison-invalid-check', 'Invalid comparison check.');
      }
      const index = check.id.split(':')[0]!;
      if (Number(index) >= maxChecks || checkIndexes.has(index)) invalid('comparison-invalid-check-index', 'Duplicate or invalid comparison check index.');
      checkIds.add(check.id); checkIndexes.add(index);
      const projected = { id: check.id, name: label(check.name), passed: check.passed };
      return projected;
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

function nativeOnlyFailure(arm: ComparisonArm | undefined, row: ComparisonRow | undefined): boolean {
  if (!arm || !row || row.nativePassed !== false) return false;
  return arm.rows.filter((candidate) => candidate.eval === row.eval && candidate.model === row.model)
    .every((candidate) => candidate.state === 'graded' && candidate.passed);
}

function counts(arm?: ComparisonArm, row?: ComparisonRow): string {
  if (!row) return !arm || arm.state === 'error' ? '⚠️ Error' : arm.state === 'not-run' ? '⏭️ Not run' : '❔ Unknown';
  if (row.state === 'error') return '⚠️ Error';
  if (row.state === 'not-run') return '⏭️ Not run';
  const passed = row.checks.filter((check) => check.passed).length;
  const failure = !row.passed ? ' (native scenario failed)' : nativeOnlyFailure(arm, row) ? ' (native eval failed)' : '';
  return `${passed}/${row.checks.length}${passed === row.checks.length ? failure : ''}`;
}

function nativeVerdict(arm: ComparisonArm | undefined): string {
  return ({ passed: '✅ Passed', failed: '❌ Failed', error: '⚠️ Error', 'not-run': '⏭️ Not run',
    cancelled: '⏭️ Cancelled', unknown: '❔ Unknown' })[arm?.nativeOutcome ?? 'unknown'];
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
  const pairs = inputPairs.filter((pair) => selection.changed.includes(pair.key)).map((pair): ComparisonPair => {
    label(pair.key);
    if (seen.has(pair.key)) invalid('comparison-duplicate-skill', 'Duplicate comparison skill.');
    seen.add(pair.key);
    return {
      key: pair.key,
      ...(pair.before !== undefined ? { before: safeArm(pair.before) } : {}),
      ...(pair.after !== undefined ? { after: safeArm(pair.after) } : {}),
    };
  });
  const comparablePairs = new Set(pairs.filter(comparable));
  const indexes = new Map<ComparisonArm, Map<string, ComparisonRow>>();
  for (const pair of pairs) for (const arm of arms) {
    const data = pair[arm];
    if (data) indexes.set(data, new Map(data.rows.map((row) => [rowIdentity(row), row])));
  }
  const findRow = (arm: ComparisonArm | undefined, row: Pick<ComparisonRow, 'eval' | 'stimulus' | 'model'>) =>
    arm ? indexes.get(arm)?.get(rowIdentity(row)) : undefined;
  const lines = [
    '## Skill eval results', '',
    `Before \`${text(selection.base.slice(0, 7))}\` → After \`${text(selection.head.slice(0, 7))}\` · [Run](${evidence})`, '',
    'Cells show **Before → After: passing / total graders**. Native eval verdicts are separate.', '',
  ];
  const append = boundedAppender(lines, maximumBytes);
  for (const skill of selection.changed) {
    const pair = pairs.find((item) => item.key === skill);
    append(`### ${text(label(skill))}`, '');
    if (!pair) {
      append('⏭️ Not run — an existing skill in both revisions and its repo eval are required.', '');
      continue;
    }
    const models = [...new Set([...(pair.before?.rows ?? []), ...(pair.after?.rows ?? [])].map((row) => row.model))].sort();
    if (!models.length) models.push('Model not observed');
    append(`**Native verdicts:** Before ${nativeVerdict(pair.before)} → After ${nativeVerdict(pair.after)}.`, '');
    append(`| Eval : scenario (passing / total graders) | ${models.map(text).join(' | ')} |`,
      `| --- | ${models.map(() => '---').join(' | ')} |`);
    const rows = scenarios(pair);
    for (const row of rows) {
      const cells = models.map((model) => {
        const identity = { ...row, model };
        const before = findRow(pair.before, identity), after = findRow(pair.after, identity);
        const known = comparablePairs.has(pair) && before && after;
        return `${counts(pair.before, before)} → ${counts(pair.after, after)}${known ? '' : ' (comparison unknown)'}`;
      });
      const short = row.stimulus.startsWith(`${row.eval}-`) ? row.stimulus.slice(row.eval.length + 1) : row.stimulus;
      append(`| ${text(row.eval)} : ${text(short)} | ${cells.join(' | ')} |`);
    }
    if (!rows.length) append(`| Evidence unavailable | ${models.map(() =>
      `${counts(pair.before)} → ${counts(pair.after)}`).join(' | ')} |`);
    append('');
  }
  append('⚠️ Error · ⏭️ Not run · ❔ Unknown are not passes. Only changed skills are shown.');
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
  let directory: string;
  let savedSelection: unknown;
  try {
    directory = await realpath(root);
    savedSelection = await artifact(directory, 'selection.json');
  }
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

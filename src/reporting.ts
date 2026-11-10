export type Count =
  | { kind: 'exact'; value: number; unit: string }
  | { kind: 'bounded'; minimum: number; maximum: number; unit: string; reason: string }
  | { kind: 'unknown' | 'not-applicable'; unit: string; reason: string };

// Action-owned display projection only. This is not a native plan or saved evidence schema.
export interface MatrixRow {
  eval: string;
  case: string;
  variant: string;
  model: string;
  repetitions: Count;
  workers: Count;
  timeout: Count;
  conditionalRetries: Count;
}
export interface ReportTokens {
  input?: number;
  output?: number;
  total: number;
}
export interface ReportGroup {
  identity: string;
  name?: string;
  passed: boolean;
  trials: number;
  stimuliRun: number;
  stimuliTotal: number;
  skipped: number;
  overallScore?: number;
  threshold?: number;
  durationMs?: number;
  tokens?: ReportTokens;
}
export interface Report {
  schemaVersion: 2;
  reportId: string;
  repository: string;
  workflowRunId: number;
  workflowRunAttempt: number;
  sourceJob: string;
  selection: string;
  suite?: string;
  command: string;
  outcome: 'error' | 'not-run' | 'planned' | 'validated' | 'passed' | 'failed' | 'cancelled';
  completeness: 'complete' | 'partial' | 'unknown';
  revision: string;
  category: 'configuration' | 'execution' | 'evidence' | 'dependency' | 'policy' | 'none';
  code: string;
  executed?: number;
  passed?: number;
  failed?: number;
  durationMs?: number;
  tokens?: ReportTokens;
  engine?: { version: string; sha256: string; dependencySha256?: string; lockSha256?: string };
  nativeRunId?: string;
  groups?: ReportGroup[];
}
export interface ReportExpectation {
  reportId: string | readonly string[];
  repository: string;
  workflowRunId: number;
  workflowRunAttempt: number;
  revision: string;
}

export function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}()!|#~]/g, '\\$&').replace(/@/g, '&#64;').replace(/[\r\n]/g, ' ');
}

export function displayCount(count: Count): string {
  const unit = escapeMarkdown(count.unit);
  if (count.kind === 'exact') return `${count.value} ${unit}`;
  if (count.kind === 'bounded') return `${count.minimum}-${count.maximum} ${unit} (${escapeMarkdown(count.reason)})`;
  return `${count.kind}: ${unit} (${escapeMarkdown(count.reason)})`;
}

export function renderMatrix(rows: readonly MatrixRow[], completeness: Report['completeness']): string {
  const header = `## Resolved matrix (${completeness})\n\n| Eval | Case | Variant | Model | Repetitions | Workers | Timeout | Conditional retries |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  return header + rows.map((row) => `| ${[
    ...[row.eval, row.case, row.variant, row.model].map(escapeMarkdown),
    ...[row.repetitions, row.workers, row.timeout, row.conditionalRetries].map(displayCount),
  ].join(' | ')} |`).join('\n') + '\n\nTrials are not API calls or currency. Conditional retries are separate from base trials.\n';
}

export function formatScore(score?: number, threshold?: number): string {
  if (score === undefined) return '-';
  return threshold !== undefined ? `${score.toFixed(2)} (threshold ${threshold.toFixed(2)})` : score.toFixed(2);
}

export function formatDuration(durationMs?: number): string {
  return durationMs === undefined ? '-' : `${durationMs}ms`;
}

export function formatTokens(tokens?: ReportTokens): string {
  if (tokens === undefined) return '-';
  if (tokens.input !== undefined && tokens.output !== undefined) {
    return `${tokens.total} tokens (${tokens.input} in / ${tokens.output} out)`;
  }
  return `${tokens.total} tokens`;
}

export function hasQualityDetails(groups: readonly ReportGroup[] | undefined): boolean {
  return Boolean(groups?.some((group) =>
    group.overallScore !== undefined || group.durationMs !== undefined || group.tokens !== undefined));
}

export function renderQualitySection(
  heading: string, groups: readonly ReportGroup[], maxGroups = 25, maxBytes = 16_000,
): string {
  const header = `${heading}\n\n| Eval | Verdict | Score | Duration | Tokens |\n| --- | --- | --- | --- | --- |\n`;
  const footer = '\n\nFurther groups are available in the structured artifact.';
  const footerBytes = Buffer.byteLength(footer, 'utf8');
  const limit = Math.min(groups.length, maxGroups);
  const rows: string[] = [];
  let usedBytes = Buffer.byteLength(header, 'utf8');
  for (let index = 0; index < limit; index++) {
    const group = groups[index]!;
    const groupName = escapeMarkdown(group.name ?? group.identity.slice(0, 12));
    const verdict = group.trials === 0 ? 'not-run' : group.passed ? 'passed' : 'failed';
    const row = `| ${groupName} | ${verdict} | ${formatScore(group.overallScore, group.threshold)} | ${formatDuration(group.durationMs)} | ${formatTokens(group.tokens)} |`;
    const rowBytes = Buffer.byteLength((rows.length ? '\n' : '') + row, 'utf8');
    const needsFooterAfterRow = index + 1 < groups.length;
    if (usedBytes + rowBytes + (needsFooterAfterRow ? footerBytes : 0) > maxBytes) break;
    rows.push(row);
    usedBytes += rowBytes;
  }
  return header + rows.join('\n') + (rows.length < groups.length ? footer : '');
}

export function renderSummary(report: Report): string {
  const metrics = [
    ...(report.durationMs !== undefined ? [`Duration: ${report.durationMs}ms.`] : []),
    ...(report.tokens !== undefined ? [
      report.tokens.input !== undefined && report.tokens.output !== undefined
        ? `Tokens: ${report.tokens.total} (${report.tokens.input} in / ${report.tokens.output} out).`
        : `Tokens: ${report.tokens.total}.`,
    ] : []),
  ].join(' ');
  return `# Evals: ${report.outcome}\n\n` +
    `Command: ${escapeMarkdown(report.command)}. Plan: ${report.completeness}.\n\n` +
    (report.suite ? `Suite: ${escapeMarkdown(report.suite)}.\n\n` : '') +
    `Revision: ${escapeMarkdown(report.revision)}\n\n` +
    `Category: ${report.category}. Diagnostic: ${escapeMarkdown(report.code)}.\n\n` +
    (report.executed === undefined ? 'Executed: unknown.\n' : `Executed: ${report.executed}.\n`) +
    (metrics ? `\n${metrics}\n` : '') +
    (report.outcome === 'not-run' ? '\n**Not an evaluation pass. A nonblocking not-run step can satisfy branch protection.**\n' : '') +
    (report.engine ? `\nVally: ${escapeMarkdown(report.engine.version)}. Executable SHA-256: ${escapeMarkdown(report.engine.sha256)}.\n` : '') +
    (report.groups?.length ? '\n| Eval | Trials executed | Stimuli run | Skipped | Native verdict |\n| --- | --- | --- | --- | --- |\n' +
      report.groups.slice(0, 100).map((group) => `| ${escapeMarkdown(group.name ?? group.identity.slice(0, 12))} | ${group.trials} | ${group.stimuliRun} | ${group.skipped} | ${group.trials === 0 ? 'not-run' : group.passed ? 'passed' : 'failed'} |`).join('\n') +
      (report.groups.length > 100 ? `\n\n${report.groups.length - 100} further groups are available in the structured artifact.` : '') + '\n' : '') +
    (report.groups && hasQualityDetails(report.groups)
      ? '\n' + renderQualitySection('## Quality and token usage', report.groups) + '\n'
      : '');
}

function serializeTokens(tokens: ReportTokens): ReportTokens {
  return {
    ...(tokens.input !== undefined && tokens.output !== undefined
      ? { input: tokens.input, output: tokens.output }
      : {}),
    total: tokens.total,
  };
}

// Explicit projection excludes arbitrary runner JSON, paths, prompts and diagnostics.
export function structuredReport(report: Report): string {
  const hasExecutedTrials = (report.executed ?? 0) > 0;
  return JSON.stringify({
    schemaVersion: 2, reportId: report.reportId, repository: report.repository,
    workflowRunId: report.workflowRunId, workflowRunAttempt: report.workflowRunAttempt,
    sourceJob: report.sourceJob, selection: report.selection,
    ...(report.suite ? { suite: report.suite } : {}),
    command: report.command, outcome: report.outcome, completeness: report.completeness,
    revision: report.revision, category: report.category, code: report.code,
    ...(report.executed !== undefined ? { executed: report.executed } : {}),
    ...(report.passed !== undefined ? { passed: report.passed } : {}),
    ...(report.failed !== undefined ? { failed: report.failed } : {}),
    ...(hasExecutedTrials && report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
    ...(hasExecutedTrials && report.tokens !== undefined ? { tokens: serializeTokens(report.tokens) } : {}),
    ...(report.engine ? { engine: {
      version: report.engine.version, sha256: report.engine.sha256,
      dependencySha256: report.engine.dependencySha256, lockSha256: report.engine.lockSha256,
    } } : {}),
    ...(report.nativeRunId ? { nativeRunId: report.nativeRunId } : {}),
    ...(report.groups ? { groups: report.groups.map(({
      identity, name, passed, trials, stimuliRun, stimuliTotal, skipped,
      overallScore, threshold, durationMs, tokens,
    }) => ({
      identity,
      ...(name ? { name } : {}),
      passed,
      trials,
      stimuliRun,
      stimuliTotal,
      skipped,
      ...(trials > 0 && overallScore !== undefined ? { overallScore } : {}),
      ...(trials > 0 && threshold !== undefined ? { threshold } : {}),
      ...(trials > 0 && durationMs !== undefined ? { durationMs } : {}),
      ...(trials > 0 && tokens !== undefined ? { tokens: serializeTokens(tokens) } : {}),
    })) } : {}),
  }, null, 2) + '\n';
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Structured report must be an object.');
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) throw new Error(`Invalid structured report ${name}.`);
  return value;
}

function count(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid structured report ${name}.`);
  return value;
}

function positive(value: unknown, name: string): number {
  const result = count(value, name);
  if (result < 1) throw new Error(`Invalid structured report ${name}.`);
  return result;
}

function unitScore(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid structured report ${name}.`);
  }
  return value;
}

function parseTokens(value: unknown, name: string): ReportTokens {
  const raw = record(value);
  if (Object.keys(raw).some((key) => !['input', 'output', 'total'].includes(key))) {
    throw new Error(`Invalid structured report ${name}.`);
  }
  const total = count(raw.total, `${name}.total`);
  const input = raw.input === undefined ? undefined : count(raw.input, `${name}.input`);
  const output = raw.output === undefined ? undefined : count(raw.output, `${name}.output`);
  if ((input === undefined) !== (output === undefined) ||
      (input !== undefined && output !== undefined && input + output > total)) {
    throw new Error(`Invalid structured report ${name}.`);
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    total,
  };
}

function tokensEqual(left: ReportTokens | undefined, right: ReportTokens | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.total === right.total && left.input === right.input && left.output === right.output;
}

export function parseStructuredReport(text: string, expected: ReportExpectation): Report {
  if (Buffer.byteLength(text, 'utf8') > 1_000_000) throw new Error('Structured report exceeds maximum size.');
  let raw: Record<string, unknown>;
  try { raw = record(JSON.parse(text)); } catch { throw new Error('Malformed Evals Action structured report.'); }
  const allowed = new Set([
    'schemaVersion', 'reportId', 'repository', 'workflowRunId', 'workflowRunAttempt', 'sourceJob', 'selection',
    'command', 'outcome', 'completeness', 'revision', 'category', 'code', 'executed', 'passed', 'failed',
    'durationMs', 'tokens', 'engine', 'nativeRunId', 'groups', 'suite',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error('Structured report contains unsupported fields.');
  if (raw.schemaVersion !== 2) throw new Error('Unsupported Evals Action structured report version.');
  const reportId = string(raw.reportId, 'reportId', /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  const repository = string(raw.repository, 'repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const workflowRunId = positive(raw.workflowRunId, 'workflowRunId');
  const workflowRunAttempt = positive(raw.workflowRunAttempt, 'workflowRunAttempt');
  const revision = string(raw.revision, 'revision', /^[a-f0-9]{40}$/);
  if (!(typeof expected.reportId === 'string' ? reportId === expected.reportId : expected.reportId.includes(reportId)) ||
      repository !== expected.repository ||
      workflowRunId !== expected.workflowRunId || workflowRunAttempt !== expected.workflowRunAttempt ||
      revision !== expected.revision) {
    throw new Error('Structured report identity does not match the current workflow.');
  }
  const command = string(raw.command, 'command');
  if (command !== 'lint' && command !== 'run') throw new Error('Structured report command is not reportable.');
  const suite = raw.suite === undefined ? undefined : string(raw.suite, 'suite');
  if (suite !== undefined && (command !== 'run' || suite.length > 256 || /[\r\n]/.test(suite))) {
    throw new Error('Invalid structured report suite.');
  }
  const outcomes: Report['outcome'][] = ['error', 'not-run', 'validated', 'passed', 'failed', 'cancelled'];
  const outcome = string(raw.outcome, 'outcome') as Report['outcome'];
  if (!outcomes.includes(outcome)) throw new Error('Invalid structured report outcome.');
  const completeness = string(raw.completeness, 'completeness') as Report['completeness'];
  if (!['complete', 'partial', 'unknown'].includes(completeness)) throw new Error('Invalid structured report completeness.');
  const category = string(raw.category, 'category') as Report['category'];
  if (!['configuration', 'execution', 'evidence', 'dependency', 'policy', 'none'].includes(category)) {
    throw new Error('Invalid structured report category.');
  }
  const optionalCount = (name: 'executed' | 'passed' | 'failed' | 'durationMs') =>
    raw[name] === undefined ? undefined : count(raw[name], name);
  const executed = optionalCount('executed');
  const passed = optionalCount('passed');
  const failed = optionalCount('failed');
  const durationMs = optionalCount('durationMs');
  const tokens = raw.tokens === undefined ? undefined : parseTokens(raw.tokens, 'tokens');
  if ((durationMs !== undefined || tokens !== undefined) && (!executed || executed < 1)) {
    throw new Error('Structured report metrics require executed trials.');
  }
  if (outcome === 'passed' && (!(executed && executed > 0) || failed !== 0)) throw new Error('Inconsistent passing structured report.');
  if (outcome === 'failed' && (!(failed && failed > 0) || !(executed && executed > 0))) throw new Error('Inconsistent failed structured report.');
  if (outcome === 'not-run' && executed !== 0) throw new Error('Inconsistent not-run structured report.');
  if (outcome === 'validated' && (command !== 'lint' || executed !== 0)) throw new Error('Inconsistent lint structured report.');
  let engine: Report['engine'];
  if (raw.engine !== undefined) {
    const value = record(raw.engine);
    if (Object.keys(value).some((key) => !['version', 'sha256', 'dependencySha256', 'lockSha256'].includes(key))) {
      throw new Error('Structured report engine contains unsupported fields.');
    }
    engine = {
      version: string(value.version, 'engine.version'),
      sha256: string(value.sha256, 'engine.sha256', /^[a-f0-9]{64}$/),
      ...(value.dependencySha256 !== undefined
        ? { dependencySha256: string(value.dependencySha256, 'engine.dependencySha256', /^[a-f0-9]{64}$/) } : {}),
      ...(value.lockSha256 !== undefined
        ? { lockSha256: string(value.lockSha256, 'engine.lockSha256', /^[a-f0-9]{64}$/) } : {}),
    };
  }
  let groups: Report['groups'];
  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups) || raw.groups.length > 1000) throw new Error('Invalid structured report groups.');
    groups = raw.groups.map((entry) => {
      const value = record(entry);
      if (Object.keys(value).some((key) => ![
        'identity', 'name', 'passed', 'trials', 'stimuliRun', 'stimuliTotal', 'skipped',
        'overallScore', 'threshold', 'durationMs', 'tokens',
      ].includes(key)) || typeof value.passed !== 'boolean') throw new Error('Invalid structured report group.');
      const name = value.name === undefined ? undefined : string(value.name, 'group.name');
      if (name !== undefined && (name.length > 256 || /[\r\n]/.test(name))) {
        throw new Error('Invalid structured report group name.');
      }
      const trials = count(value.trials, 'group.trials');
      const stimuliRun = count(value.stimuliRun, 'group.stimuliRun');
      const stimuliTotal = count(value.stimuliTotal, 'group.stimuliTotal');
      const skipped = count(value.skipped, 'group.skipped');
      if (stimuliRun > trials ||
          ((trials === 0) !== (stimuliRun === 0)) ||
          stimuliRun + skipped > stimuliTotal) {
        throw new Error('Inconsistent structured report group counts.');
      }
      const overallScore = value.overallScore === undefined ? undefined : unitScore(value.overallScore, 'group.overallScore');
      const threshold = value.threshold === undefined ? undefined : unitScore(value.threshold, 'group.threshold');
      if ((overallScore === undefined) !== (threshold === undefined)) {
        throw new Error('Invalid structured report group scoring.');
      }
      const groupDurationMs = value.durationMs === undefined ? undefined : count(value.durationMs, 'group.durationMs');
      const groupTokens = value.tokens === undefined ? undefined : parseTokens(value.tokens, 'group.tokens');
      if (trials === 0 && (overallScore !== undefined || threshold !== undefined || groupDurationMs !== undefined || groupTokens !== undefined)) {
        throw new Error('Structured report group with zero trials cannot include execution metrics.');
      }
      return {
        identity: string(value.identity, 'group.identity', /^[a-f0-9]{64}$/),
        ...(name ? { name } : {}),
        passed: value.passed,
        trials,
        stimuliRun, stimuliTotal, skipped,
        ...(overallScore !== undefined ? { overallScore } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(groupDurationMs !== undefined ? { durationMs: groupDurationMs } : {}),
        ...(groupTokens !== undefined ? { tokens: groupTokens } : {}),
      };
    });
  }
  if (groups !== undefined) {
    const groupExecuted = groups.reduce((total, group) => total + group.trials, 0);
    const groupPassed = groups.filter((group) => group.trials > 0 && group.passed).length;
    const groupFailed = groups.filter((group) => group.trials > 0 && !group.passed).length;
    if (executed !== groupExecuted ||
        (passed !== undefined && passed !== groupPassed) ||
        (failed !== undefined && failed !== groupFailed)) {
      throw new Error('Structured report totals contradict native group evidence.');
    }
    const executedGroups = groups.filter((group) => group.trials > 0);
    const expectedDurationMs = executedGroups.length > 0 && executedGroups.every((group) => group.durationMs !== undefined)
      ? executedGroups.reduce((total, group) => total + group.durationMs!, 0)
      : undefined;
    const expectedTokens: ReportTokens | undefined = executedGroups.length > 0 && executedGroups.every((group) => group.tokens !== undefined)
      ? {
          ...(executedGroups.every((group) => group.tokens!.input !== undefined && group.tokens!.output !== undefined)
            ? {
                input: executedGroups.reduce((sum, group) => sum + group.tokens!.input!, 0),
                output: executedGroups.reduce((sum, group) => sum + group.tokens!.output!, 0),
              }
            : {}),
          total: executedGroups.reduce((sum, group) => sum + group.tokens!.total, 0),
        }
      : undefined;
    if (durationMs !== expectedDurationMs || !tokensEqual(tokens, expectedTokens)) {
      throw new Error('Structured report metrics contradict native group evidence.');
    }
    if ((outcome === 'passed' && (groupExecuted === 0 || groupFailed !== 0 || passed !== groupPassed)) ||
        (outcome === 'failed' && (groupFailed === 0 || failed !== groupFailed)) ||
        (outcome === 'not-run' && groupExecuted !== 0)) {
      throw new Error('Structured report outcome contradicts native group evidence.');
    }
  } else if (outcome === 'passed' || outcome === 'failed' || outcome === 'not-run') {
    throw new Error('Terminal native outcomes require group evidence.');
  }
  return {
    schemaVersion: 2, reportId, repository, workflowRunId, workflowRunAttempt,
    sourceJob: string(raw.sourceJob, 'sourceJob', /^[A-Za-z0-9_.-]+$/),
    selection: string(raw.selection, 'selection', /^[a-f0-9]{64}$/),
    ...(suite ? { suite } : {}),
    command, outcome, completeness, revision, category,
    code: string(raw.code, 'code', /^[a-z0-9-]+$/),
    ...(executed !== undefined ? { executed } : {}), ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(engine ? { engine } : {}),
    ...(raw.nativeRunId !== undefined ? { nativeRunId: string(raw.nativeRunId, 'nativeRunId') } : {}),
    ...(groups ? { groups } : {}),
  };
}

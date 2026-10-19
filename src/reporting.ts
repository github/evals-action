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
export interface Report {
  schemaVersion: 2;
  reportId: string;
  repository: string;
  workflowRunId: number;
  workflowRunAttempt: number;
  sourceJob: string;
  selection: string;
  command: string;
  outcome: 'error' | 'not-run' | 'planned' | 'validated' | 'passed' | 'failed' | 'cancelled';
  completeness: 'complete' | 'partial' | 'unknown';
  revision: string;
  category: 'configuration' | 'execution' | 'evidence' | 'dependency' | 'policy' | 'none';
  code: string;
  executed?: number;
  passed?: number;
  failed?: number;
  engine?: { version: string; sha256: string; dependencySha256?: string; lockSha256?: string };
  nativeRunId?: string;
  groups?: Array<{ identity: string; passed: boolean; trials: number; stimuliRun: number; stimuliTotal: number; skipped: number }>;
}
export interface ReportExpectation {
  reportId: string;
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

export function renderSummary(report: Report): string {
  return `# Evals: ${report.outcome}\n\n` +
    `Command: ${escapeMarkdown(report.command)}. Plan: ${report.completeness}.\n\n` +
    `Revision: ${escapeMarkdown(report.revision)}\n\n` +
    `Category: ${report.category}. Diagnostic: ${escapeMarkdown(report.code)}.\n\n` +
    (report.executed === undefined ? 'Executed: unknown.\n' : `Executed: ${report.executed}.\n`) +
    (report.outcome === 'not-run' ? '\n**Not an evaluation pass. A nonblocking not-run step can satisfy branch protection.**\n' : '') +
    (report.engine ? `\nVally: ${escapeMarkdown(report.engine.version)}. Executable SHA-256: ${escapeMarkdown(report.engine.sha256)}.\n` : '') +
    (report.groups?.length ? '\n| Native eval identity | Trials executed | Stimuli run | Skipped | Native verdict |\n| --- | --- | --- | --- | --- |\n' +
      report.groups.map((group) => `| ${group.identity.slice(0, 12)} | ${group.trials} | ${group.stimuliRun} | ${group.skipped} | ${group.trials === 0 ? 'not-run' : group.passed ? 'passed' : 'failed'} |`).join('\n') + '\n' : '');
}

// Explicit projection excludes arbitrary runner JSON, paths, prompts and diagnostics.
export function structuredReport(report: Report): string {
  return JSON.stringify({
    schemaVersion: 2, reportId: report.reportId, repository: report.repository,
    workflowRunId: report.workflowRunId, workflowRunAttempt: report.workflowRunAttempt,
    sourceJob: report.sourceJob, selection: report.selection,
    command: report.command, outcome: report.outcome, completeness: report.completeness,
    revision: report.revision, category: report.category, code: report.code,
    ...(report.executed !== undefined ? { executed: report.executed } : {}),
    ...(report.passed !== undefined ? { passed: report.passed } : {}),
    ...(report.failed !== undefined ? { failed: report.failed } : {}),
    ...(report.engine ? { engine: {
      version: report.engine.version, sha256: report.engine.sha256,
      dependencySha256: report.engine.dependencySha256, lockSha256: report.engine.lockSha256,
    } } : {}),
    ...(report.nativeRunId ? { nativeRunId: report.nativeRunId } : {}),
    ...(report.groups ? { groups: report.groups.map(({ identity, passed, trials, stimuliRun, stimuliTotal, skipped }) =>
      ({ identity, passed, trials, stimuliRun, stimuliTotal, skipped })) } : {}),
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

export function parseStructuredReport(text: string, expected: ReportExpectation): Report {
  let raw: Record<string, unknown>;
  try { raw = record(JSON.parse(text)); } catch { throw new Error('Malformed Evals Action structured report.'); }
  const allowed = new Set([
    'schemaVersion', 'reportId', 'repository', 'workflowRunId', 'workflowRunAttempt', 'sourceJob', 'selection',
    'command', 'outcome', 'completeness', 'revision', 'category', 'code', 'executed', 'passed', 'failed',
    'engine', 'nativeRunId', 'groups',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error('Structured report contains unsupported fields.');
  if (raw.schemaVersion !== 2) throw new Error('Unsupported Evals Action structured report version.');
  const reportId = string(raw.reportId, 'reportId', /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  const repository = string(raw.repository, 'repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const workflowRunId = positive(raw.workflowRunId, 'workflowRunId');
  const workflowRunAttempt = positive(raw.workflowRunAttempt, 'workflowRunAttempt');
  const revision = string(raw.revision, 'revision', /^[a-f0-9]{40}$/);
  if (reportId !== expected.reportId || repository !== expected.repository ||
      workflowRunId !== expected.workflowRunId || workflowRunAttempt !== expected.workflowRunAttempt ||
      revision !== expected.revision) {
    throw new Error('Structured report identity does not match the current workflow.');
  }
  const command = string(raw.command, 'command');
  if (command !== 'lint' && command !== 'run') throw new Error('Structured report command is not reportable.');
  const outcomes: Report['outcome'][] = ['error', 'not-run', 'validated', 'passed', 'failed', 'cancelled'];
  const outcome = string(raw.outcome, 'outcome') as Report['outcome'];
  if (!outcomes.includes(outcome)) throw new Error('Invalid structured report outcome.');
  const completeness = string(raw.completeness, 'completeness') as Report['completeness'];
  if (!['complete', 'partial', 'unknown'].includes(completeness)) throw new Error('Invalid structured report completeness.');
  const category = string(raw.category, 'category') as Report['category'];
  if (!['configuration', 'execution', 'evidence', 'dependency', 'policy', 'none'].includes(category)) {
    throw new Error('Invalid structured report category.');
  }
  const optionalCount = (name: 'executed' | 'passed' | 'failed') =>
    raw[name] === undefined ? undefined : count(raw[name], name);
  const executed = optionalCount('executed');
  const passed = optionalCount('passed');
  const failed = optionalCount('failed');
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
    if (!Array.isArray(raw.groups) || raw.groups.length > 10_000) throw new Error('Invalid structured report groups.');
    groups = raw.groups.map((entry) => {
      const value = record(entry);
      if (Object.keys(value).some((key) => !['identity', 'passed', 'trials', 'stimuliRun', 'stimuliTotal', 'skipped'].includes(key)) ||
          typeof value.passed !== 'boolean') throw new Error('Invalid structured report group.');
      const trials = count(value.trials, 'group.trials');
      const stimuliRun = count(value.stimuliRun, 'group.stimuliRun');
      const stimuliTotal = count(value.stimuliTotal, 'group.stimuliTotal');
      const skipped = count(value.skipped, 'group.skipped');
      if (stimuliRun > trials ||
          ((trials === 0) !== (stimuliRun === 0)) ||
          stimuliRun + skipped > stimuliTotal) {
        throw new Error('Inconsistent structured report group counts.');
      }
      return {
        identity: string(value.identity, 'group.identity', /^[a-f0-9]{64}$/),
        passed: value.passed,
        trials,
        stimuliRun, stimuliTotal, skipped,
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
    command, outcome, completeness, revision, category,
    code: string(raw.code, 'code', /^[a-z0-9-]+$/),
    ...(executed !== undefined ? { executed } : {}), ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}), ...(engine ? { engine } : {}),
    ...(raw.nativeRunId !== undefined ? { nativeRunId: string(raw.nativeRunId, 'nativeRunId') } : {}),
    ...(groups ? { groups } : {}),
  };
}

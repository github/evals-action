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
  schemaVersion: 1;
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
    schemaVersion: 1, command: report.command, outcome: report.outcome, completeness: report.completeness,
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

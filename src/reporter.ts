import { parseDocument } from 'yaml';
import { commentMarker, orderedBody, selectComment, type Comment, type CommentIdentity, type ReportOrder } from './comments.js';
import { object } from './policy.js';
import {
  escapeMarkdown, formatDurationDelta, formatScoreDelta, formatTokenDelta,
  hasQualityDetails, renderComparisonSection, renderQualitySection, renderVerdictSummaryTable,
  type GroupVerdictEntry, type Report,
} from './reporting.js';
import { ReportingError, type GitHubClient } from './github.js';

export const commentConcurrencyGroup = 'evals-${{ github.workflow_ref }}';
export interface CommentContext {
  repository: string;
  workflowRef: string;
  workflowSha: string;
  job: string;
  reportId: string;
  selection: string;
  pullNumber: number;
  runId: number;
  order: ReportOrder;
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ReportingError('invalid-report-identity');
  return value;
}

function workflowPath(context: CommentContext): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) || !/^[a-f0-9]{40}$/.test(context.workflowSha)) {
    throw new ReportingError('invalid-workflow-identity');
  }
  const prefix = `${context.repository}/`;
  const suffix = context.workflowRef.startsWith(prefix) ? context.workflowRef.slice(prefix.length) : '';
  const match = /^(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@refs\/pull\/(\d+)\/merge$/.exec(suffix);
  if (!match?.[1] || Number(match[2]) !== context.pullNumber) throw new ReportingError('unsupported-workflow-reference');
  return match[1];
}

export function assertSerializedReporter(source: string, context: CommentContext): void {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new ReportingError('invalid-workflow-document');
  const workflow = object(document.toJS({ maxAliasCount: 0 }));
  const job = object(object(workflow.jobs)[context.job]);
  const concurrency = object(job.concurrency ?? workflow.concurrency);
  if (concurrency.group !== commentConcurrencyGroup || concurrency['cancel-in-progress'] !== false) {
    throw new ReportingError('workflow-report-serialization-required');
  }
  if (job.strategy !== undefined || !Array.isArray(job.steps)) throw new ReportingError('matrix-or-reusable-report-job-unsupported');
  const actionSteps = job.steps.map(object).filter((step) =>
    typeof step.uses === 'string' && (/^github\/evals-action@[A-Za-z0-9_./-]+$/i.test(step.uses) || step.uses === './'));
  const reports = actionSteps.map((step) => object(step.with ?? {}))
    .filter((inputs) => ['all', 'report'].includes(String(inputs.command ?? 'all')));
  if (reports.some((inputs) => typeof (inputs['report-id'] ?? 'evals') !== 'string' || String(inputs['report-id'] ?? 'evals').includes('${{'))) {
    throw new ReportingError('literal-report-identity-required');
  }
  const matching = reports.filter((inputs) => String(inputs['report-id'] ?? 'evals').replace(/-(?:lint|run)$/, '') === context.reportId);
  const pairedReportSteps = matching.length === 2 && matching.every((inputs) => inputs.command === 'report') &&
    matching.some((inputs) => inputs['report-id'] === `${context.reportId}-lint`) &&
    matching.some((inputs) => inputs['report-id'] === `${context.reportId}-run`);
  if (matching.length !== 1 && !pairedReportSteps) {
    throw new ReportingError('unique-report-step-required');
  }
}

function comment(value: unknown): Comment {
  const entry = object(value);
  const user = object(entry.user);
  if (typeof entry.body !== 'string') throw new ReportingError('invalid-comment-body');
  return { id: positive(entry.id), authorId: positive(user.id), body: entry.body };
}

async function currentPull(client: GitHubClient, context: CommentContext, revision: string): Promise<void> {
  const pull = object(await client.request('GET', `/repos/${context.repository}/pulls/${context.pullNumber}`));
  const head = object(pull.head);
  if (pull.state !== 'open' || object(head.repo).full_name !== context.repository ||
      object(object(pull.base).repo).full_name !== context.repository ||
      (head.sha !== revision && pull.merge_commit_sha !== revision)) {
    throw new ReportingError('pull-request-source-is-stale-or-excluded');
  }
}

export async function postReport(
  client: GitHubClient, context: CommentContext, report: Report, artifactId?: number,
  companion?: { report: Report; artifactId: number },
  baseline?: { report: Report; artifactId: number },
): Promise<'created' | 'updated' | 'stale'> {
  positive(context.pullNumber); positive(context.runId);
  if (!/^[a-f0-9]{40}$/.test(report.revision)) throw new ReportingError('invalid-report-revision');
  if (artifactId !== undefined) positive(artifactId);
  if (report.reportId.replace(/-(?:lint|run)$/, '') !== context.reportId ||
        (companion && (report.command !== 'run' || companion.report.command !== 'lint' ||
          ![report.reportId, context.reportId, `${context.reportId}-lint`].includes(companion.report.reportId) ||
          companion.report.outcome !== 'validated' ||
          companion.report.repository !== report.repository ||
          companion.report.revision !== report.revision ||
          companion.report.workflowRunId !== report.workflowRunId ||
          companion.report.workflowRunAttempt !== report.workflowRunAttempt)) ||
        (baseline && (report.command !== 'run' || baseline.report.command !== 'run' ||
          baseline.report.reportId.replace(/-(?:lint|run)$/, '') === context.reportId ||
          baseline.report.repository !== report.repository ||
          baseline.report.revision !== report.revision ||
          baseline.report.workflowRunId !== report.workflowRunId ||
          baseline.report.workflowRunAttempt !== report.workflowRunAttempt))) {
    throw new ReportingError('inconsistent-report-evidence');
  }
  if (companion) {
    positive(companion.artifactId);
    if (companion.artifactId === artifactId) throw new ReportingError('inconsistent-report-evidence');
  }
  if (baseline) {
    positive(baseline.artifactId);
    if (baseline.artifactId === artifactId || baseline.artifactId === companion?.artifactId) {
      throw new ReportingError('inconsistent-report-evidence');
    }
  }
  const path = workflowPath(context);
  const source = object(await client.request('GET', `/repos/${context.repository}/contents/${path}?ref=${context.workflowSha}`));
  if (source.encoding !== 'base64' || typeof source.content !== 'string' || source.content.length > 1_500_000) {
    throw new ReportingError('workflow-source-unavailable');
  }
  const sourceText = Buffer.from(source.content, 'base64').toString('utf8');
  assertSerializedReporter(sourceText, context);
  await currentPull(client, context, report.revision);
  const response = object(await client.request('POST', '/graphql', { query: 'query { viewer { databaseId login } }' }));
  if (response.errors !== undefined) throw new ReportingError('report-author-unavailable');
  const viewer = object(object(response.data).viewer);
  if (typeof viewer.login !== 'string' || !viewer.login.endsWith('[bot]')) throw new ReportingError('reporting-bot-token-required');
  const author = positive(viewer.databaseId);
  const identity: CommentIdentity = {
    repository: context.repository, workflow: path, job: 'report', report: context.reportId,
  };
  const comments: Comment[] = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new ReportingError('comment-pagination-limit');
    const entries = await client.request('GET', `/repos/${context.repository}/issues/${context.pullNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(entries)) throw new ReportingError('invalid-comment-list');
    comments.push(...entries.map(comment));
    if (entries.length < 100) break;
  }
  const decision = selectComment(comments, identity, context.order, author);
  if (decision.action === 'stale') return 'stale';
  const run = `https://github.com/${context.repository}/actions/runs/${context.runId}`;
  const summary = renderComment(report, artifactId, companion, run, baseline);
  const body = orderedBody(identity, context.order, summary +
    `\n[Exact revision](https://github.com/${context.repository}/commit/${report.revision}) | [Workflow run](${run})` +
    '\n');
  if (Buffer.byteLength(body, 'utf8') > 60_000) throw new ReportingError('report-comment-too-large');
  // Workflow concurrency serializes writers. This refresh additionally rejects pushes during reporting.
  await currentPull(client, context, report.revision);
  const written = comment(await client.request(
    decision.action === 'create' ? 'POST' : 'PATCH',
    decision.action === 'create'
      ? `/repos/${context.repository}/issues/${context.pullNumber}/comments`
      : `/repos/${context.repository}/issues/comments/${decision.id}`,
    { body },
  ));
  if (written.authorId !== author || written.body !== body || !written.body.startsWith(commentMarker(identity))) {
    throw new ReportingError('comment-write-identity-mismatch');
  }

  const verified = comment(await client.request('GET', `/repos/${context.repository}/issues/comments/${written.id}`));
  if (verified.authorId !== author || verified.body !== body || verified.id !== written.id) {
    throw new ReportingError('comment-readback-mismatch');
  }
  return decision.action === 'create' ? 'created' : 'updated';
}

function renderGroupDetailsBlock(entry: GroupVerdictEntry, run: string, artifactId?: number): string {
  const emoji = entry.verdict.split(' ')[0];
  const baseGroup = entry.baseGroup;
  const candGroup = entry.candGroup;
  const sameTrials = baseGroup !== undefined && candGroup !== undefined && baseGroup.trials === candGroup.trials;
  const modelName = candGroup?.model ? escapeMarkdown(candGroup.model) : '-';
  const evidenceCell = artifactId !== undefined ? `[artifact](${run}/artifacts/${artifactId})` : '-';
  return `<details>\n` +
    `<summary>${emoji} <strong>${entry.name}</strong> — ${entry.why}</summary>\n\n` +
    '| Metric | Baseline | Candidate | Delta |\n| --- | --- | --- | --- |\n' +
    `| Verdict | ${baseGroup ? (baseGroup.trials === 0 ? 'not-run' : baseGroup.passed ? 'passed' : 'failed') : '-'} | ${candGroup ? (candGroup.trials === 0 ? 'not-run' : candGroup.passed ? 'passed' : 'failed') : '-'} | ${entry.transition} |\n` +
    `| Model | ${baseGroup?.model ? escapeMarkdown(baseGroup.model) : '-'} | ${modelName} | - |\n` +
    `| Scenarios / Trials | ${baseGroup ? `${baseGroup.stimuliRun}/${baseGroup.stimuliTotal} (${baseGroup.trials} trials)` : '-'} | ${candGroup ? `${candGroup.stimuliRun}/${candGroup.stimuliTotal} (${candGroup.trials} trials)` : '-'} | - |\n` +
    `| Score | ${baseGroup?.overallScore !== undefined ? baseGroup.overallScore.toFixed(2) : '-'} | ${candGroup?.overallScore !== undefined ? `${candGroup.overallScore.toFixed(2)}${candGroup.threshold !== undefined ? ` (threshold ${candGroup.threshold.toFixed(2)})` : ''}` : '-'} | ${formatScoreDelta(baseGroup?.overallScore, candGroup?.overallScore)} |\n` +
    `| Turns | ${baseGroup?.turns ?? '-'} | ${candGroup?.turns ?? '-'} | ${sameTrials && baseGroup?.turns !== undefined && candGroup?.turns !== undefined ? (candGroup.turns - baseGroup.turns > 0 ? `+${candGroup.turns - baseGroup.turns}` : `${candGroup.turns - baseGroup.turns}`) : '-'} |\n` +
    `| Duration | ${baseGroup?.durationMs !== undefined ? `${baseGroup.durationMs}ms` : '-'} | ${candGroup?.durationMs !== undefined ? `${candGroup.durationMs}ms` : '-'} | ${sameTrials ? formatDurationDelta(baseGroup?.durationMs, candGroup?.durationMs) : '-'} |\n` +
    `| Tokens | ${baseGroup?.tokens ? `${baseGroup.tokens.total} (${baseGroup.tokens.input ?? '-'} in / ${baseGroup.tokens.output ?? '-'} out)` : '-'} | ${candGroup?.tokens ? `${candGroup.tokens.total} (${candGroup.tokens.input ?? '-'} in / ${candGroup.tokens.output ?? '-'} out)` : '-'} | ${sameTrials ? formatTokenDelta(baseGroup?.tokens, candGroup?.tokens) : '-'} |\n` +
    `| Evidence | - | ${evidenceCell} | - |\n\n` +
    `</details>\n\n`;
}

export function renderComment(
  report: Report, artifactId: number | undefined, companion: { report: Report; artifactId: number } | undefined, run: string,
  baseline?: { report: Report; artifactId: number },
): string {
  const lint = companion?.report ?? (report.command === 'lint' ? report : undefined);
  const evaluation = report.command === 'run' ? report : undefined;
  const status = evaluation?.outcome ?? lint?.outcome ?? report.outcome;
  const rows = evaluation?.groups ?? [];
  const suite = evaluation?.suite;
  if (!baseline || !evaluation) {
    const base = `# Evals: ${status}\n\n` +
      (suite ? `**Suite:** ${escapeMarkdown(suite)}\n\n` : evaluation ? '**Selection:** Native eval paths or tags\n\n' : '') +
      (lint ? `**Lint:** ${lint.outcome}${lint.outcome === 'validated' ? ' (no model execution)' : ` - ${escapeMarkdown(lint.code)}`}` +
        ((companion?.artifactId ?? artifactId) !== undefined ? ` - [Evidence](${run}/artifacts/${companion?.artifactId ?? artifactId})` : '') + '\n\n' : '') +
      (evaluation ? `**Run:** ${evaluation.outcome} - ${evaluation.executed ?? 'unknown'} ${evaluation.executed === 1 ? 'trial' : 'trials'}` +
        (artifactId !== undefined ? ` - [Evidence](${run}/artifacts/${artifactId})` : '') + '\n\n' +
        (['error', 'failed', 'cancelled'].includes(evaluation.outcome) ? `Diagnostic: ${escapeMarkdown(evaluation.code)}.\n\n` : '') +
        (evaluation.outcome === 'not-run' ? '**Not an evaluation pass.**\n\n' : '') +
        (rows.length ? '| Eval | Trials | Result |\n| --- | ---: | --- |\n' +
          rows.slice(0, 100).map((group) =>
            `| ${escapeMarkdown(group.name ?? group.identity.slice(0, 12))} | ${group.trials} | ${group.trials ? group.passed ? 'passed' : 'failed' : 'not-run'} |`,
          ).join('\n') + '\n\n' +
          (rows.length > 100 ? `${rows.length - 100} further groups are in the structured artifact.\n\n` : '') : '') : '');
    if (!evaluation) return base;
    let output = base;
    if (rows.length && hasQualityDetails(rows)) {
      const maxQualityBytes = Math.min(16_000, Math.max(0, 57_500 - Buffer.byteLength(output, 'utf8')));
      const quality = renderQualitySection('### Quality & token summary', rows, 25, maxQualityBytes);
      if (quality) output = `${output}${quality}\n\n`;
    }
    return output;
  }

  const { overallVerdict, entries, markdown: verdictTable } = renderVerdictSummaryTable(baseline.report, evaluation, 25);
  let output = `# Evals: ${overallVerdict} (${status})\n\n` +
    (verdictTable ? `${verdictTable}\n\n` : '') +
    (['error', 'failed', 'cancelled'].includes(evaluation.outcome) ? `Diagnostic: ${escapeMarkdown(evaluation.code)}.\n\n` : '') +
    (evaluation.outcome === 'not-run' ? '**Not an evaluation pass.**\n\n' : '');

  const allActionable = entries.filter((entry) => entry.verdict !== '✅ Ship');
  const allPassingChanged = entries.filter((entry) => entry.verdict === '✅ Ship' && (entry.changed || entries.length === 1));
  const unchangedPassing = entries.filter((entry) => entry.verdict === '✅ Ship' && !entry.changed && entries.length > 1);

  let droppedActionable = allActionable.length > 25;
  for (const entry of allActionable.slice(0, 25)) {
    const block = renderGroupDetailsBlock(entry, run, artifactId);
    if (Buffer.byteLength(output + block, 'utf8') <= 38_000) output += block;
    else droppedActionable = true;
  }
  if (droppedActionable) {
    output += 'Further groups are available in the structured artifact.\n\n';
  }
  if (allActionable.length > 0) {
    output += '---\n\n';
  }
  let droppedPassing = allPassingChanged.length > 25;
  for (const entry of allPassingChanged.slice(0, 25)) {
    const block = renderGroupDetailsBlock(entry, run, artifactId);
    if (Buffer.byteLength(output + block, 'utf8') <= 38_000) output += block;
    else droppedPassing = true;
  }
  if (droppedPassing) {
    output += 'Further groups are available in the structured artifact.\n\n';
  }
  if (unchangedPassing.length > 0) {
    const totalRun = unchangedPassing.reduce((sum, entry) => sum + (entry.candGroup?.stimuliRun ?? 0), 0);
    const totalStimuli = unchangedPassing.reduce((sum, entry) => sum + (entry.candGroup?.stimuliTotal ?? 0), 0);
    const unchangedHeader =
      `<details>\n` +
      `<summary>📋 <strong>Unchanged evals &amp; run configuration</strong> — ${unchangedPassing.length} passing (${totalRun}/${totalStimuli} scenarios)</summary>\n\n` +
      '| Skill | Status | Scenarios (Before → After) | Details |\n| --- | --- | --- | --- |\n';
    const unchangedFooter = '\n\nFurther groups are available in the structured artifact.\n\n</details>\n\n';
    const unchangedClose = '\n\n</details>\n\n';
    const unchangedRows: string[] = [];
    let usedUnchanged = Buffer.byteLength(output + unchangedHeader + unchangedClose, 'utf8');
    for (const entry of unchangedPassing.slice(0, 25)) {
      const b = entry.baseGroup;
      const c = entry.candGroup;
      const model = c?.model ? escapeMarkdown(c.model) : b?.model ? escapeMarkdown(b.model) : 'default';
      const detail = c && c.skipped > 0
        ? `Passed (${c.skipped} skipped) on \`${model}\``
        : `All scenarios passing on \`${model}\``;
      const row = `| \`${entry.name}\` | ✅ Unchanged | ${b ? `${b.stimuliRun}/${b.stimuliTotal}` : '-'} → ${c ? `${c.stimuliRun}/${c.stimuliTotal}` : '-'} | ${detail} |`;
      const rowBytes = Buffer.byteLength((unchangedRows.length ? '\n' : '') + row, 'utf8');
      if (usedUnchanged + rowBytes + Buffer.byteLength(unchangedFooter, 'utf8') > 38_000) break;
      unchangedRows.push(row);
      usedUnchanged += rowBytes;
    }
    if (unchangedRows.length > 0) {
      output += unchangedHeader + unchangedRows.join('\n') +
        (unchangedRows.length < unchangedPassing.length ? unchangedFooter : unchangedClose);
    }
  }

  let telemetryBody =
    (suite ? `**Suite:** ${escapeMarkdown(suite)}\n\n` : '**Selection:** Native eval paths or tags\n\n') +
    (lint ? `**Lint:** ${lint.outcome}${lint.outcome === 'validated' ? ' (no model execution)' : ` - ${escapeMarkdown(lint.code)}`}` +
      ((companion?.artifactId ?? artifactId) !== undefined ? ` - [Evidence](${run}/artifacts/${companion?.artifactId ?? artifactId})` : '') + '\n\n' : '') +
    `**Run:** ${evaluation.outcome} - ${evaluation.executed ?? 'unknown'} ${evaluation.executed === 1 ? 'trial' : 'trials'}` +
    (artifactId !== undefined ? ` - [Evidence](${run}/artifacts/${artifactId})` : '') + '\n\n' +
    `**Baseline:** ${baseline.report.outcome} - ${baseline.report.executed ?? 'unknown'} ${baseline.report.executed === 1 ? 'trial' : 'trials'} - [Evidence](${run}/artifacts/${baseline.artifactId})\n\n`;

  if (rows.length) {
    const evalTableHeader = '| Eval | Trials | Result |\n| --- | ---: | --- |\n';
    const evalRows: string[] = [];
    for (const group of rows.slice(0, 25)) {
      const evalRow = `| ${escapeMarkdown(group.name ?? group.identity.slice(0, 12))} | ${group.trials} | ${group.trials ? group.passed ? 'passed' : 'failed' : 'not-run'} |`;
      if (Buffer.byteLength(output + telemetryBody + evalTableHeader + evalRows.join('\n') + '\n' + evalRow, 'utf8') > 46_000) break;
      evalRows.push(evalRow);
    }
    if (evalRows.length > 0) {
      telemetryBody += evalTableHeader + evalRows.join('\n') + '\n\n' +
        (evalRows.length < rows.length ? `${rows.length - evalRows.length} further groups are in the structured artifact.\n\n` : '');
    }
  }

  if (rows.length && hasQualityDetails(rows)) {
    const maxQualityBytes = Math.min(16_000, Math.max(0, 56_000 - Buffer.byteLength(output + telemetryBody, 'utf8')));
    const quality = renderQualitySection('### Quality & token summary', rows, 25, maxQualityBytes);
    if (quality) telemetryBody = `${telemetryBody}${quality}\n\n`;
  }
  const maxComparisonBytes = Math.min(16_000, Math.max(0, 56_000 - Buffer.byteLength(output + telemetryBody, 'utf8')));
  const comparison = renderComparisonSection('### Baseline vs. Candidate comparison', baseline.report, evaluation, 25, maxComparisonBytes, overallVerdict);
  if (comparison) telemetryBody = `${telemetryBody}${comparison}\n\n`;

  output += `<details>\n<summary>📊 <strong>Telemetry, token deltas &amp; run evidence</strong></summary>\n\n${telemetryBody.trim()}\n\n</details>\n\n`;
  return output;
}

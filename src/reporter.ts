import { parseDocument } from 'yaml';
import { commentMarker, orderedBody, selectComment, type Comment, type CommentIdentity, type ReportOrder } from './comments.js';
import { object } from './policy.js';
import { escapeMarkdown, hasQualityDetails, renderQualitySection, type Report } from './reporting.js';
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
          companion.report.workflowRunAttempt !== report.workflowRunAttempt))) {
    throw new ReportingError('inconsistent-report-evidence');
  }
  if (companion) {
    positive(companion.artifactId);
    if (companion.artifactId === artifactId) throw new ReportingError('inconsistent-report-evidence');
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
  const summary = renderComment(report, artifactId, companion, run);
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

export function renderComment(
  report: Report, artifactId: number | undefined, companion: { report: Report; artifactId: number } | undefined, run: string,
): string {
  const lint = companion?.report ?? (report.command === 'lint' ? report : undefined);
  const evaluation = report.command === 'run' ? report : undefined;
  const status = evaluation?.outcome ?? lint?.outcome ?? report.outcome;
  const rows = evaluation?.groups ?? [];
  const suite = evaluation?.suite;
  return `# Evals: ${status}\n\n` +
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
        (rows.length > 100 ? `${rows.length - 100} further groups are in the structured artifact.\n\n` : '') +
        (hasQualityDetails(rows)
          ? renderQualitySection('### Quality & token summary', rows) + '\n\n'
          : '') : '') : '');
}

import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { object } from './policy.js';
import type { GitHubClient } from './github.js';

const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const name = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._/-]{0,199}$/.test(value);
export class ComparisonError extends Error {
  constructor(public readonly code: string, message = code) { super(message); }
}
export interface ComparisonContext {
  repository: string;
  sourceWorkflow: string;
  workflowRef: string;
  sourceRun: string;
  sourceAttempt: string;
  run: string;
  attempt: string;
  runNumber: number;
  pullNumber: number;
  head: string;
  runHead: string;
  trusted: string;
  base: string;
  merge: string;
}
export interface ComparisonEntry {
  key: string;
  id: string;
  directory: string;
  evalPath: string;
  base: string;
  head: string;
}
export interface ComparisonSelection extends ComparisonContext {
  changed: string[];
  skills: { key: string; hasEval: boolean }[];
  include: ComparisonEntry[];
}

export async function assertCurrentPullRequest(context: Pick<ComparisonContext, 'repository' | 'pullNumber' | 'head'>, api: GitHubClient): Promise<Record<string, unknown>> {
  const pull = object(await api.request('GET', `/repos/${context.repository}/pulls/${context.pullNumber}`));
  const head = object(pull.head);
  if (pull.state !== 'open' || head.sha !== context.head || object(head.repo).full_name !== context.repository) {
    throw new ComparisonError('comparison-pr-stale-closed-or-fork');
  }
  return pull;
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number {
  const text = env[key] ?? '';
  const value = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !positive(value)) throw new ComparisonError('comparison-invalid-workflow-identity');
  return value;
}

export async function authenticateComparison(
  payload: unknown, sourceWorkflow: string, api: GitHubClient, env: NodeJS.ProcessEnv,
  producingAttempt = env.GITHUB_RUN_ATTEMPT,
): Promise<ComparisonContext> {
  const repository = env.GITHUB_REPOSITORY ?? '';
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(sourceWorkflow)) {
    throw new ComparisonError('comparison-invalid-source-workflow');
  }
  if (env.GITHUB_EVENT_NAME !== 'workflow_run' || !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !sha(env.GITHUB_SHA) || env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA) {
    throw new ComparisonError('comparison-requires-trusted-workflow-run');
  }
  const currentAttempt = envNumber(env, 'GITHUB_RUN_ATTEMPT');
  const runId = envNumber(env, 'GITHUB_RUN_ID');
  const runNumber = envNumber(env, 'GITHUB_RUN_NUMBER');
  const attempt = Number(producingAttempt);
  if (!/^[1-9]\d*$/.test(producingAttempt ?? '') || !positive(attempt) || attempt > currentAttempt) {
    throw new ComparisonError('comparison-invalid-producing-attempt');
  }
  const repo = object(await api.request('GET', `/repos/${repository}`));
  const workflowRef = env.GITHUB_WORKFLOW_REF;
  if (typeof repo.default_branch !== 'string' || typeof workflowRef !== 'string' ||
      !workflowRef.startsWith(`${repository}/.github/workflows/`) || !workflowRef.endsWith(`@refs/heads/${repo.default_branch}`)) {
    throw new ComparisonError('comparison-workflow-not-default-branch');
  }
  const source = object(object(payload).workflow_run);
  if (!positive(source.id) || !positive(source.run_attempt)) throw new ComparisonError('comparison-invalid-source-run');
  const prefix = `/repos/${repository}`;
  const run = object(await api.request('GET', `${prefix}/actions/runs/${source.id}/attempts/${source.run_attempt}`));
  if (run.id !== source.id || run.run_attempt !== source.run_attempt || object(run.repository).full_name !== repository ||
      object(run.head_repository).full_name !== repository || run.event !== 'pull_request' || run.status !== 'completed' ||
      run.conclusion === 'cancelled' || !sha(run.head_sha) || !positive(run.workflow_id)) {
    throw new ComparisonError('comparison-source-run-mismatch');
  }
  const workflow = object(await api.request('GET', `${prefix}/actions/workflows/${run.workflow_id}`));
  if (workflow.path !== sourceWorkflow) throw new ComparisonError('comparison-source-workflow-mismatch');
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1 ||
      !Array.isArray(source.pull_requests) || source.pull_requests.length !== 1) {
    throw new ComparisonError('comparison-source-pr-association-missing');
  }
  const associated = object(run.pull_requests[0]);
  const head = object(associated.head).sha;
  if (!positive(associated.number) || !sha(head) || object(source.pull_requests[0]).number !== associated.number) {
    throw new ComparisonError('comparison-source-pr-association-mismatch');
  }
  if (run.head_sha !== head) throw new ComparisonError('comparison-source-head-mismatch');
  const identity = {
    repository, sourceWorkflow, workflowRef, sourceRun: String(source.id), sourceAttempt: String(source.run_attempt),
    run: String(runId), attempt: String(attempt), runNumber, pullNumber: associated.number,
    head, runHead: run.head_sha, trusted: env.GITHUB_SHA,
  };
  const pull = await assertCurrentPullRequest(identity, api);
  if (!sha(pull.merge_commit_sha)) throw new ComparisonError('comparison-merge-unavailable');
  const commit = object(await api.request('GET', `${prefix}/git/commits/${pull.merge_commit_sha}`));
  if (commit.sha !== pull.merge_commit_sha || !Array.isArray(commit.parents) || commit.parents.length !== 2 ||
      !sha(object(commit.parents[0]).sha) || object(commit.parents[1]).sha !== head) {
    throw new ComparisonError('comparison-merge-parents-mismatch');
  }
  return { ...identity, base: object(commit.parents[0]).sha as string, merge: pull.merge_commit_sha };
}

export function assertContext(actual: ComparisonContext, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) throw new ComparisonError('comparison-context-mismatch');
}

function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && value.split('/').every((part) =>
    /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..', '.git'].includes(part.toLowerCase()));
}

export function validateComparisonSelection(value: unknown, context: ComparisonContext): ComparisonSelection {
  const selected = object(value);
  for (const [key, expected] of Object.entries(context)) {
    if (selected[key] !== expected) throw new ComparisonError('comparison-selection-context-mismatch');
  }
  if (!Array.isArray(selected.changed) || !Array.isArray(selected.skills) || !Array.isArray(selected.include) ||
      [selected.changed, selected.skills, selected.include].some((items) => items.length > 1000) ||
      !selected.changed.every(name) || new Set(selected.changed).size !== selected.changed.length) {
    throw new ComparisonError('comparison-invalid-selection');
  }
  const skills = selected.skills.map((raw) => {
    let skill: Record<string, unknown>;
    try { skill = object(raw); }
    catch { throw new ComparisonError('comparison-invalid-inventory'); }
    if (!name(skill.key) || typeof skill.hasEval !== 'boolean') throw new ComparisonError('comparison-invalid-inventory');
    return { key: skill.key, hasEval: skill.hasEval };
  });
  const skillKeys = new Set(skills.map((skill) => skill.key));
  if (skillKeys.size !== skills.length) throw new ComparisonError('comparison-duplicate-inventory');
  const changed = selected.changed;
  const ids = new Set<string>(), keys = new Set<string>();
  const include = selected.include.map((raw): ComparisonEntry => {
    let entry: Record<string, unknown>;
    try { entry = object(raw); }
    catch { throw new ComparisonError('comparison-invalid-selection-entry'); }
    if (!name(entry.key) || typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) ||
        ids.has(entry.id) || keys.has(entry.key) || !changed.includes(entry.key) || !skillKeys.has(entry.key) ||
        !safePath(entry.directory) || !safePath(entry.evalPath) ||
        entry.evalPath === entry.directory || entry.evalPath.startsWith(`${entry.directory}/`) ||
        posix.normalize(entry.directory) !== entry.directory || entry.base !== context.base || entry.head !== context.head) {
      throw new ComparisonError('comparison-invalid-selection-entry');
    }
    ids.add(entry.id); keys.add(entry.key);
    return { key: entry.key, id: entry.id, directory: entry.directory, evalPath: entry.evalPath, base: context.base, head: context.head };
  });
  const normalized = { ...context, changed: selected.changed as string[], skills, include };
  if (!isDeepStrictEqual(normalized, value)) throw new ComparisonError('comparison-unrecognized-selection-fields');
  return normalized;
}

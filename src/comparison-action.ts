import * as core from '@actions/core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { authenticatedBotId, githubClient, takeSecretInput, type GitHubClient } from './github.js';
import { inertEnvironment, projectDirectory } from './policy.js';
import { exactVersion, parseInputs } from './inputs.js';
import { acquireEngine, resolveRelease, type EngineIdentity } from './tooling.js';
import { nativeEnvironment, runNative } from './native.js';
import { authenticateComparison, assertContext, assertCurrentPullRequest, ComparisonError, validateComparisonSelection,
  type ComparisonContext, type ComparisonEntry, type ComparisonSelection } from './comparison-context.js';
import { collectNative, loadComparison, renderComparison, type ComparisonArm } from './comparison-report.js';

const execute = promisify(execFile);
const maximum = 1024 * 1024;
const parse = (text: string): unknown => {
  if (Buffer.byteLength(text) > maximum) throw new ComparisonError('comparison-json-too-large');
  try { return JSON.parse(text); } catch { throw new ComparisonError('comparison-malformed-json'); }
};

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute('git', ['--literal-pathspecs', '-C', cwd, ...args], {
    env: inertEnvironment(process.env), timeout: 30_000, maxBuffer: 8 * maximum,
  });
  return result.stdout.trim();
}

export async function restoreComparisonSource(cwd: string, context: ComparisonContext, entry: ComparisonEntry, source: string): Promise<void> {
  if (await git(cwd, ['rev-parse', 'HEAD']) !== context.merge ||
      await git(cwd, ['rev-parse', 'HEAD^1']) !== context.base ||
      await git(cwd, ['rev-parse', 'HEAD^2']) !== context.head) {
    throw new ComparisonError('comparison-checkout-revision-mismatch');
  }
  // Reject symlinked path components before Git or the evaluator can follow them.
  const checkPaths = async () => {
    for (const path of [entry.directory, entry.evalPath]) {
      let current = cwd;
      for (const component of path.split('/')) {
        current = join(current, component);
        if ((await lstat(current)).isSymbolicLink()) throw new ComparisonError('comparison-symlinked-measurement-path');
      }
    }
  };
  await checkPaths();
  await git(cwd, ['restore', `--source=${source}`, '--staged', '--worktree', '--', entry.directory]);
  await checkPaths();
  await git(cwd, ['diff', '--exit-code', source, '--', entry.directory]);
  // This pathspec is constructed from a validated directory, never candidate shell text.
  const outside = await execute('git', ['-C', cwd, 'diff', '--name-only', '-z', 'HEAD', '--', '.', `:(exclude,literal)${entry.directory}`], {
    env: inertEnvironment(process.env), timeout: 30_000, maxBuffer: 8 * maximum,
  });
  if (outside.stdout || await git(cwd, ['ls-files', '--others', '-z'])) {
    throw new ComparisonError('comparison-measurement-files-changed');
  }
}

export async function publishComparison(
  selection: ComparisonSelection, body: string, api: GitHubClient,
): Promise<'posted' | 'stale'> {
  const marker = `<!-- evals-comparison:${selection.repository}/${selection.sourceWorkflow} -->`;
  const prefix = `/repos/${selection.repository}`;
  const author = await authenticatedBotId(api);
  let existing: { id: number; body: string } | undefined;
  for (let page = 1; page <= 100; page++) {
    const batch = await api.request('GET', `${prefix}/issues/${selection.pullNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new ComparisonError('comparison-invalid-comment-list');
    for (const raw of batch) {
      if (typeof raw !== 'object' || raw === null) throw new ComparisonError('comparison-invalid-comment');
      const comment = raw as { id?: unknown; body?: unknown; user?: { id?: unknown } };
      if (comment.user?.id === author &&
          typeof comment.body === 'string' && comment.body.startsWith(marker)) {
        if (existing || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id) || comment.id < 1) {
          throw new ComparisonError('comparison-ambiguous-comment');
        }
        existing = { id: comment.id, body: comment.body };
      }
    }
    if (batch.length < 100) break;
    if (page === 100) throw new ComparisonError('comparison-comment-list-too-large');
  }
  const order = [selection.runNumber, Number(selection.attempt)];
  const previous = existing?.body.match(/<!-- run:(\d+):(\d+) -->/);
  if (previous && (Number(previous[1]) > order[0]! ||
      Number(previous[1]) === order[0] && Number(previous[2]) > order[1]!)) return 'stale';
  const content = `${marker}\n<!-- run:${order.join(':')} -->\n${body}`;
  if (Buffer.byteLength(content) > 60_000) throw new ComparisonError('comparison-comment-too-large');
  await assertCurrentPullRequest(selection, api);
  await api.request(existing ? 'PATCH' : 'POST',
    existing ? `${prefix}/issues/comments/${existing.id}` : `${prefix}/issues/${selection.pullNumber}/comments`, { body: content });
  return 'posted';
}

interface PairDependencies {
  restore: typeof restoreComparisonSource;
  current: () => Promise<void>;
  run: typeof runNative;
}

export async function runComparisonPair(
  context: ComparisonContext, selection: ComparisonSelection, entry: ComparisonEntry, engine: EngineIdentity,
  cwd: string, directory: string, token: string, api: GitHubClient,
  dependencies: PairDependencies = {
    restore: restoreComparisonSource,
    current: async () => { await assertCurrentPullRequest(context, api); },
    run: runNative,
  },
): Promise<boolean> {
  let passed = true;
  let cancelled = false;
  for (const arm of ['before', 'after'] as const) {
    const path = join(directory, `${entry.id}-${arm}.json`);
    const serialize = (data: ComparisonArm) => JSON.stringify({
      id: entry.id, key: entry.key, arm, repository: selection.repository,
      run: selection.run, attempt: selection.attempt, merge: selection.merge, data,
    }) + '\n';
    let data: ComparisonArm = { state: 'error', rows: [] };
    try {
      if (cancelled) throw new ComparisonError('comparison-cancelled-before-arm');
      await dependencies.restore(cwd, context, entry, arm === 'before' ? entry.base : entry.head);
      await dependencies.current();
      const native = await mkdtemp(join(directory, `${arm}-native-`));
      const home = join(native, 'home'), tmp = join(native, 'tmp');
      await mkdir(home, { mode: 0o700 });
      await mkdir(tmp, { mode: 0o700 });
      const values: Record<string, string> = {
        command: 'run', 'working-directory': '.', 'eval-paths': entry.evalPath,
        runs: '1', workers: '1', 'max-retries': '0',
      };
      const inputs = parseInputs((name) => values[name] ?? '');
      const env = nativeEnvironment(inputs, process.env, home, '', token);
      Object.assign(env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
      const operation = await dependencies.run(inputs, engine, cwd, native, env);
      cancelled = operation.result.outcome === 'cancelled';
      passed &&= operation.result.outcome === 'passed';
      if (operation.files[0] && operation.result.nativeRunId) {
        if ((await stat(operation.files[0])).size > 64 * maximum) throw new ComparisonError('comparison-native-evidence-too-large');
        const projected = collectNative(await readFile(operation.files[0], 'utf8'), operation.result.nativeRunId, operation.exitCode ?? null);
        if (Buffer.byteLength(serialize(projected)) > maximum) throw new ComparisonError('comparison-projection-too-large');
        data = projected;
      }
      if (data.state !== 'complete' || data.rows.some((row) => row.state !== 'graded')) passed = false;
    } catch (error) {
      passed = false;
      core.warning(`Comparison ${arm} failed: ${error instanceof ComparisonError ? error.code : 'comparison-arm-error'}. No raw diagnostics published.`);
    }
    await writeFile(path, serialize(data), { mode: 0o600, flag: 'wx' });
    core.setOutput(`${arm}-path`, path);
  }
  return passed;
}

export async function runComparisonAction(): Promise<void> {
  const token = takeSecretInput('GITHUB-TOKEN', () => core.getInput('github-token'), process.env, core.setSecret);
  const copilot = takeSecretInput('COPILOT-TOKEN', () => core.getInput('copilot-token'), process.env, core.setSecret);
  const command = core.getInput('command').trim();
  if (!['context', 'run', 'report'].includes(command)) throw new ComparisonError('comparison-invalid-command');
  if (command !== 'run' && copilot) throw new ComparisonError('comparison-unexpected-execution-credential');
  if (command === 'run' && (process.platform !== 'linux' || process.arch !== 'x64')) {
    throw new ComparisonError('comparison-requires-linux-x64');
  }
  const api = githubClient(token, process.env.RUNNER_TEMP!);
  const payload = parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  const producing = core.getInput('producing-attempt').trim() || process.env.GITHUB_RUN_ATTEMPT;
  if (command !== 'context' && !core.getInput('producing-attempt').trim()) throw new ComparisonError('comparison-producing-attempt-required');
  if (command !== 'report' && producing !== process.env.GITHUB_RUN_ATTEMPT) {
    throw new ComparisonError('comparison-partial-paid-retry-unsupported');
  }
  const context = await authenticateComparison(payload, core.getInput('source-workflow').trim(), api, process.env, producing);
  if (command === 'context') {
    const directory = await mkdtemp(join(process.env.RUNNER_TEMP!, 'evals-comparison-context-'));
    const path = join(directory, 'context.json');
    await writeFile(path, JSON.stringify(context) + '\n', { mode: 0o600, flag: 'wx' });
    core.setOutput('context', JSON.stringify(context));
    core.setOutput('context-path', path);
    core.setOutput('merge', context.merge);
    return;
  }
  assertContext(context, parse(core.getInput('context')));
  const selection = validateComparisonSelection(parse(core.getInput('selection')), context);
  if (command === 'report') {
    const directory = core.getInput('artifact-directory');
    if (!isAbsolute(directory)) throw new ComparisonError('comparison-artifact-directory-must-be-absolute');
    const { pairs } = await loadComparison(directory, selection);
    const evidence = `https://github.com/${context.repository}/actions/runs/${context.run}/attempts/${context.attempt}`;
    const body = renderComparison(selection, pairs, evidence);
    const outcome = await publishComparison(selection, body, api);
    core.setOutput('outcome', outcome);
    await core.summary.addRaw(body).write();
    return;
  }
  if (!copilot) throw new ComparisonError('comparison-copilot-token-required');
  const entry = selection.include.find((item) => item.id === core.getInput('comparison-id'));
  if (!entry) throw new ComparisonError('comparison-entry-not-selected');
  const cwd = await projectDirectory(process.env.GITHUB_WORKSPACE!, core.getInput('working-directory'));
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP!, 'evals-comparison-'));
  const rel = relative(cwd, directory);
  if (!rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new ComparisonError('comparison-output-inside-candidate');
  const version = core.getInput('vally-version').trim();
  if (!exactVersion(version)) throw new ComparisonError('comparison-exact-vally-version-required');
  // Acquisition never reads candidate manifests. Both arms share this one integrity-locked graph.
  const tools = await mkdtemp(join(process.env.RUNNER_TEMP!, 'evals-comparison-tools-'));
  const engine = await acquireEngine(await resolveRelease(version, tools), tools);
  await writeFile(join(directory, 'selection.json'), JSON.stringify(selection) + '\n', { mode: 0o600, flag: 'wx' });
  core.setOutput('projection-directory', directory);
  const passed = await runComparisonPair(context, selection, entry, engine, cwd, directory, copilot, api, {
    restore: restoreComparisonSource, run: runNative,
    current: async () => {
      assertContext(await authenticateComparison(payload, context.sourceWorkflow, api, process.env), context);
    },
  });
  core.setOutput('outcome', passed ? 'passed' : 'failed');
  await core.summary.addRaw(`Comparison source: ${context.sourceRun}/${context.sourceAttempt}; producer: ${context.run}/${context.attempt}.\n\n` +
    `Trusted workflow: ${context.trusted}; evaluated merge: ${context.merge}; Before: ${context.base}; After: ${context.head}.\n\n` +
    `Vally ${engine.version}; dependency lock SHA-256: ${engine.lockSha256}; dependency graph SHA-256: ${engine.dependencySha256}.\n`).write();
  if (!passed) core.setFailed('Comparison did not pass. Failed, incomplete and not-run evidence is not a pass.');
}

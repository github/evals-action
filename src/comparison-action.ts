import * as core from '@actions/core';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import { finished } from 'node:stream/promises';
import { devNull } from 'node:os';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { authenticatedBotId, githubClient, ReportingError, takeSecretInput, type GitHubClient } from './github.js';
import { inertEnvironment, projectDirectory } from './policy.js';
import { exactVersion, parseInputs } from './inputs.js';
import { acquireEngine, resolveRelease, type EngineIdentity, type EngineRelease } from './tooling.js';
import { NativeError, nativeEnvironment, runNative } from './native.js';
import { authenticateComparison, assertContext, assertCurrentPullRequest, ComparisonError, validateComparisonSelection,
  type ComparisonContext, type ComparisonEntry, type ComparisonSelection } from './comparison-context.js';
import { collectNative, comparisonCommentMetadata, loadComparison, renderComparison, type ComparisonArm } from './comparison-report.js';

const execute = promisify(execFile);
const maximum = 1024 * 1024;
const gitControls = ['--no-replace-objects', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false'];
export function comparisonErrorCode(error: unknown, fallback: string): string {
  return error instanceof ComparisonError || error instanceof NativeError || error instanceof ReportingError ? error.code : fallback;
}

const parse = (text: string): unknown => {
  if (Buffer.byteLength(text) > maximum) throw new ComparisonError('comparison-json-too-large');
  try { return JSON.parse(text); } catch { throw new ComparisonError('comparison-malformed-json'); }
};

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const operation = execute('git', [...gitControls, `--work-tree=${cwd}`, '--literal-pathspecs', '-C', cwd, ...args], {
    env: inertEnvironment(process.env), timeout: 30_000, maxBuffer: 8 * maximum,
  });
  const writing = input === undefined ? undefined : finished(operation.child.stdin!, { cleanup: true });
  if (input !== undefined) operation.child.stdin!.end(input);
  const [result] = await Promise.all([operation, writing]);
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}

export async function restoreComparisonSource(cwd: string, context: ComparisonContext, entry: ComparisonEntry, source: string): Promise<void> {
  let revisions: string[];
  try { revisions = await Promise.all(['HEAD', 'HEAD^1', 'HEAD^2'].map((revision) => git(cwd, ['rev-parse', revision]))); }
  catch { throw new ComparisonError('comparison-checkout-revision-mismatch'); }
  if (revisions[0] !== context.merge || revisions[1] !== context.base || revisions[2] !== context.head) {
    throw new ComparisonError('comparison-checkout-revision-mismatch');
  }
  const index = await git(cwd, ['ls-files', '-v', '-z']);
  if (index.split('\0').some((entry) => /^[a-zS] /.test(entry))) {
    throw new ComparisonError('comparison-hidden-index-flags');
  }
  const staged = await git(cwd, ['ls-files', '--stage', '-z']);
  for (const record of staged.split('\0').filter((row) => row.startsWith('160000 '))) {
    const path = join(cwd, record.slice(record.indexOf('\t') + 1));
    try {
      if (!(await lstat(path)).isDirectory() || (await readdir(path)).length > 0) {
        throw new ComparisonError('comparison-initialized-submodule-unsupported');
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
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
  const checkFilters = async () => {
    const paths = await git(cwd, ['ls-files', '-z']);
    for (const cached of [false, true]) {
      const attributes = await git(cwd, ['check-attr', ...(cached ? ['--cached'] : []), '-z', '--all', '--stdin'], paths);
      if (attributes.split('\0').some((value, index) => index % 3 === 1 && value === 'filter')) {
        throw new ComparisonError('comparison-git-filters-unsupported');
      }
    }
  };
  await checkPaths();
  await checkFilters();
  const previousTree = await git(cwd, ['write-tree']);
  try {
    await git(cwd, ['restore', `--source=${source}`, '--staged', '--', entry.directory]);
    await checkFilters();
  } finally { await git(cwd, ['read-tree', previousTree]); }
  await git(cwd, ['restore', `--source=${source}`, '--staged', '--worktree', '--', entry.directory]);
  await checkPaths();
  await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--exit-code', source, '--', entry.directory]);
  // This pathspec is constructed from a validated directory, never candidate shell text.
  const outside = await execute('git', [...gitControls, `--work-tree=${cwd}`, '-C', cwd, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--', '.', `:(exclude,literal)${entry.directory}`], {
    env: inertEnvironment(process.env), timeout: 30_000, maxBuffer: 8 * maximum,
  });
  if (outside.stdout || await git(cwd, ['ls-files', '--others', '--directory', '-z'])) {
    throw new ComparisonError('comparison-measurement-files-changed');
  }
}

export async function measurementDigest(cwd: string, skillDirectory: string): Promise<string> {
  const hash = createHash('sha256');
  const excluded = new Set([join(cwd, '.git'), join(cwd, ...skillDirectory.split('/'))]);
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      if (excluded.has(path)) continue;
      let info = await lstat(path);
      hash.update(relative(cwd, path)).update('\0').update(String(info.mode & 0o777)).update('\0');
      if (info.isSymbolicLink()) {
        hash.update('link\0').update(await readlink(path)).update('\0');
        try { info = await stat(path); }
        catch { throw new ComparisonError('comparison-unsupported-measurement-symlink'); }
        if (!info.isFile()) throw new ComparisonError('comparison-unsupported-measurement-symlink');
        hash.update(String(info.mode & 0o777)).update('\0');
      }
      if (info.isDirectory()) { hash.update('directory\0'); await visit(path); }
      else if (info.isFile()) {
        hash.update('file\0').update(String(info.size)).update('\0');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
      } else throw new ComparisonError('comparison-unsupported-measurement-file');
      hash.update('\0');
    }
  };
  await visit(cwd);
  return hash.digest('hex');
}

export async function publishComparison(
  selection: ComparisonSelection, body: string, api: GitHubClient,
): Promise<'posted' | 'stale'> {
  const { marker, prefix: metadata } = comparisonCommentMetadata(selection);
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
  const content = `${metadata}${body}`;
  if (Buffer.byteLength(content) > 60_000) throw new ComparisonError('comparison-comment-too-large');
  const pull = await assertCurrentPullRequest(selection, api);
  if (pull.merge_commit_sha !== selection.merge) throw new ComparisonError('comparison-pr-merge-changed');
  await api.request(existing ? 'PATCH' : 'POST',
    existing ? `${prefix}/issues/comments/${existing.id}` : `${prefix}/issues/${selection.pullNumber}/comments`, { body: content });
  return 'posted';
}

interface PairDependencies {
  restore: typeof restoreComparisonSource;
  current: () => Promise<void>;
  run: typeof runNative;
  measurements: typeof measurementDigest;
}

export async function runComparisonPair(
  context: ComparisonContext, selection: ComparisonSelection, entry: ComparisonEntry, engine: EngineIdentity,
  cwd: string, directory: string, token: string, api: GitHubClient,
  dependencies: PairDependencies = {
    restore: restoreComparisonSource,
    current: async () => { await assertCurrentPullRequest(context, api); },
    run: runNative,
    measurements: measurementDigest,
  },
): Promise<boolean> {
  let passed = true;
  let cancelled = false;
  let baseline: string | undefined;
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
      const digest = await dependencies.measurements(cwd, entry.directory);
      if (baseline !== undefined && digest !== baseline) throw new ComparisonError('comparison-measurement-bytes-changed');
      baseline = digest;
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
      if (operation.result.outcome !== 'planned' && operation.result.outcome !== 'validated') {
        data.nativeOutcome = operation.result.outcome;
      }
      cancelled = operation.result.outcome === 'cancelled';
      passed &&= operation.result.outcome === 'passed';
      if (await dependencies.measurements(cwd, entry.directory) !== baseline) {
        throw new ComparisonError('comparison-measurement-bytes-changed');
      }
      if (operation.files[0] && operation.result.nativeRunId) {
        if ((await stat(operation.files[0])).size > 64 * maximum) throw new ComparisonError('comparison-native-evidence-too-large');
        const projected = collectNative(await readFile(operation.files[0], 'utf8'), operation.result.nativeRunId, operation.exitCode ?? null);
        if (Buffer.byteLength(serialize(projected)) > maximum) throw new ComparisonError('comparison-projection-too-large');
        data = { ...projected, nativeOutcome: projected.nativeOutcome ?? data.nativeOutcome ?? 'unknown' };
      }
      if (data.state !== 'complete' || data.rows.some((row) => row.state !== 'graded')) passed = false;
    } catch (error) {
      passed = false;
      core.warning(`Comparison ${arm} failed: ${comparisonErrorCode(error, 'comparison-arm-error')}. No raw diagnostics published.`);
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
  let cwd: string;
  try { cwd = await projectDirectory(process.env.GITHUB_WORKSPACE!, core.getInput('working-directory')); }
  catch { throw new ComparisonError('comparison-working-directory-invalid'); }
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP!, 'evals-comparison-'));
  const rel = relative(cwd, directory);
  if (!rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new ComparisonError('comparison-output-inside-candidate');
  const version = core.getInput('vally-version').trim();
  if (!exactVersion(version)) throw new ComparisonError('comparison-exact-vally-version-required');
  // Acquisition never reads candidate manifests. Both arms share this one integrity-locked graph.
  const tools = await mkdtemp(join(process.env.RUNNER_TEMP!, 'evals-comparison-tools-'));
  let release: EngineRelease;
  try { release = await resolveRelease(version, tools); }
  catch { throw new ComparisonError('comparison-vally-resolution-failed'); }
  let engine: EngineIdentity;
  try { engine = await acquireEngine(release, tools); }
  catch { throw new ComparisonError('comparison-vally-acquisition-failed'); }
  await writeFile(join(directory, 'selection.json'), JSON.stringify(selection) + '\n', { mode: 0o600, flag: 'wx' });
  core.setOutput('projection-directory', directory);
  const passed = await runComparisonPair(context, selection, entry, engine, cwd, directory, copilot, api, {
    restore: restoreComparisonSource, run: runNative, measurements: measurementDigest,
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

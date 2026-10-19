import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Inputs } from './inputs.js';
import { inertEnvironment, object } from './policy.js';
import type { Report } from './reporting.js';
import { sha256, type EngineIdentity } from './tooling.js';

export class NativeError extends Error {
  constructor(public readonly code: string, public readonly category: Report['category'] = 'configuration') { super(code); }
}
export interface ProcessResult { code: number | null; cancelled: boolean; stdout: string; stderr: string }
export type Invoke = (engine: EngineIdentity, args: string[], cwd: string, env: NodeJS.ProcessEnv, directory: string) => Promise<ProcessResult>;
export interface NativeResult {
  outcome: Report['outcome'];
  completeness: Report['completeness'];
  category: Report['category'];
  code: string;
  executed?: number;
  passed?: number;
  failed?: number;
  nativeRunId?: string;
  groups?: Report['groups'];
}

export function nativeArguments(inputs: Inputs, cwd: string, directory: string, runId: string): string[][] {
  if (inputs.command === 'plan') throw new NativeError('vally-plan-not-supported');
  if (inputs.command === 'lint') {
    if (Object.keys(inputs.overrides).length) throw new NativeError('vally-lint-does-not-support-execution-overrides');
    return [['lint', `--eval-spec=${resolve(cwd)}`]];
  }
  if (inputs.suite && (inputs.evalPaths.length || inputs.tags.length)) throw new NativeError('vally-suite-cannot-combine-with-paths-or-tags');
  const args = ['eval', '--require-pass', '--output=jsonl', `--run-id=${runId}`, `--output-dir=${join(directory, 'artifacts')}`, `--work-dir=${cwd}`];
  if (inputs.suite) args.push(`--suite=${inputs.suite}`);
  for (const path of inputs.evalPaths) args.push(`--eval-spec=${resolve(cwd, path)}`);
  for (const tag of inputs.tags) args.push(`--tag=${tag}`);
  for (const [key, flag] of [['model', 'model'], ['runs', 'runs'], ['workers', 'workers'], ['maxRetries', 'max-retries']] as const) {
    if (inputs.overrides[key] !== undefined) args.push(`--${flag}=${inputs.overrides[key]}`);
  }
  if (inputs.overrides.timeout !== undefined) args.push(`--timeout=${inputs.overrides.timeout}s`);
  return [args];
}

export function nativeEnvironment(
  inputs: Inputs, source: NodeJS.ProcessEnv, home: string, reportToken: string, copilotToken = '',
): NodeJS.ProcessEnv {
  const env = inertEnvironment(source);
  env.HOME = home;
  env.VALLY_TELEMETRY_OPTOUT = '1';
  env.DO_NOT_TRACK = '1';
  env.OTEL_SDK_DISABLED = 'true';
  if (inputs.command !== 'run') return env;
  const forbidden = /^(GITHUB_|GH_|ACTIONS_|RUNNER_|INPUT_|NODE_|NPM_|PNPM_|GIT_|LD_|DYLD_)|^(PATH|HOME|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|COMSPEC|SYSTEMROOT|WINDIR|TMP|TEMP|TMPDIR|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT)$/;
  const reportingSecrets = [reportToken, source.GH_TOKEN, source.ACTIONS_RUNTIME_TOKEN].filter(Boolean);
  if (copilotToken) {
    if (inputs.credentialEnv.includes('COPILOT_GITHUB_TOKEN')) throw new NativeError('copilot-token-input-cannot-combine-with-credential-env');
    if (reportingSecrets.includes(copilotToken)) throw new NativeError('reporting-token-cannot-be-an-evaluator-credential');
    env.COPILOT_GITHUB_TOKEN = copilotToken;
  }
  for (const name of new Set(inputs.credentialEnv)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || forbidden.test(name)) throw new NativeError('protected-credential-environment-name');
    const value = source[name];
    if (value) {
      // Actions tokens can grant copilot-requests:write. Allow that explicit alias only;
      // keep GITHUB_TOKEN itself out of Vally's SDK user-token option and reject reporting-token reuse.
      if (reportingSecrets.includes(value) || (name !== 'COPILOT_GITHUB_TOKEN' && value === source.GITHUB_TOKEN)) {
        throw new NativeError('reporting-token-cannot-be-an-evaluator-credential');
      }
      env[name] = value;
    }
  }
  return env;
}

export const invokeVally: Invoke = async (engine, args, cwd, env, directory) => {
  const id = randomUUID();
  const stdout = join(directory, `${id}.stdout.log`);
  const stderr = join(directory, `${id}.stderr.log`);
  const out = await open(stdout, 'wx', 0o600);
  let err: Awaited<ReturnType<typeof open>> | undefined;
  try {
    err = await open(stderr, 'wx', 0o600);
    const errorFd = err.fd;
    return await new Promise<ProcessResult>((resolveResult, reject) => {
      const grouped = process.platform === 'linux';
      const child = spawn(process.execPath, [engine.entry, ...args], {
        cwd, env, shell: false, detached: grouped, stdio: ['ignore', out.fd, errorFd],
      });
      let cancelled = false;
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const signalChild = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          if (grouped) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) reject(error);
        }
      };
      const cancel = () => {
        cancelled = true;
        signalChild('SIGINT');
        killTimer ??= setTimeout(() => signalChild('SIGKILL'), 25_000);
      };
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      // Runs use the workflow's job timeout. Bound only version/lint control commands here.
      const timeout = args[0] === 'eval' ? undefined : setTimeout(() => {
        timedOut = true;
        signalChild('SIGKILL');
      }, args[0] === 'lint' ? 300_000 : 30_000);
      const cleanup = () => {
        process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
        clearTimeout(timeout); clearTimeout(killTimer);
      };
      child.once('error', () => { cleanup(); reject(new NativeError('vally-process-start-failed', 'execution')); });
      child.once('close', (code) => {
        if (cancelled && grouped) signalChild('SIGKILL');
        cleanup();
        if (timedOut) reject(new NativeError('vally-control-command-timed-out', 'execution'));
        else resolveResult({ code, cancelled, stdout, stderr });
      });
    });
  } finally {
    await out.close();
    await err?.close();
  }
};

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NativeError('invalid-native-count', 'evidence');
  return value;
}

export function parseNativeEvidence(text: string, runId: string, exitCode: number | null): NativeResult {
  const rows: Record<string, unknown>[] = [];
  try {
    for (const line of text.split(/\r?\n/).filter((line) => line.trim())) rows.push(object(JSON.parse(line)));
  } catch {
    throw new NativeError('malformed-native-jsonl', 'evidence');
  }
  const summary = rows.at(-1);
  if (!summary || summary.type !== 'run-summary' || rows.filter((row) => row.type === 'run-summary').length !== 1) {
    throw new NativeError('native-run-summary-missing', 'evidence');
  }
  if (rows.some((row) => row.runId !== runId) || typeof summary.passed !== 'boolean' ||
      typeof summary.hadExecutionErrors !== 'boolean' || !Array.isArray(summary.evals)) {
    throw new NativeError('native-evidence-identity-or-schema-mismatch', 'evidence');
  }
  const trials = rows.slice(0, -1);
  const itemIds = new Set<string>();
  const buckets = new Map<string, { trials: number; stimuli: Set<string>; skipped: number; name?: string }>();
  let executionErrors = summary.hadExecutionErrors;
  for (const trial of trials) {
    if (trial.type !== 'trial-result' || typeof trial.itemId !== 'string' || itemIds.has(trial.itemId) ||
        typeof trial.evalFilePath !== 'string' || typeof trial.variant !== 'string' || typeof trial.stimulus !== 'string' ||
        (trial.model !== undefined && typeof trial.model !== 'string') ||
        !['success', 'error', 'skipped'].includes(String(trial.status))) {
      throw new NativeError('invalid-native-trial', 'evidence');
    }
    itemIds.add(trial.itemId);
    const key = sha256(JSON.stringify([trial.evalFilePath, trial.variant, trial.model ?? '']));
    const bucket = buckets.get(key) ?? { trials: 0, stimuli: new Set<string>(), skipped: 0 };
    if (trial.evalName !== undefined) {
      if (typeof trial.evalName !== 'string' || !trial.evalName || trial.evalName.length > 256 ||
          /[\r\n]/.test(trial.evalName) || (bucket.name !== undefined && bucket.name !== trial.evalName)) {
        throw new NativeError('inconsistent-native-eval-name', 'evidence');
      }
      bucket.name = trial.evalName;
    }
    if (trial.status === 'skipped') bucket.skipped++;
    else {
      bucket.trials++;
      bucket.stimuli.add(trial.stimulus);
      if (trial.status === 'error') executionErrors = true;
      if (trial.status === 'success' && (trial.gradeResult === undefined || trial.trajectory === null || trial.trajectory === undefined)) {
        throw new NativeError('native-trial-evidence-missing', 'evidence');
      }
      if (trial.status === 'success') {
        try {
          const trajectory = object(trial.trajectory);
          if (typeof trajectory.id !== 'string' || typeof trajectory.output !== 'string') throw new Error('Invalid native trajectory.');
          // Null is the native contract for an ungraded trial. Never invent a grader requirement.
          const pending: unknown[] = trial.gradeResult === null ? [] : [trial.gradeResult];
          while (pending.length) {
            const grade = object(pending.pop());
            if (typeof grade.passed !== 'boolean' || typeof grade.score !== 'number' || !Number.isFinite(grade.score) ||
                (grade.status !== undefined && grade.status !== 'success' && grade.status !== 'error')) throw new Error('Invalid native grade.');
            if (grade.status === 'error') executionErrors = true;
            if (grade.details !== undefined) {
              if (!Array.isArray(grade.details)) throw new Error('Invalid native grade details.');
              for (const detail of grade.details) pending.push(detail);
            }
          }
        } catch {
          throw new NativeError('native-trial-evidence-malformed', 'evidence');
        }
      }
    }
    buckets.set(key, bucket);
  }
  const seen = new Set<string>();
  const groups: NonNullable<Report['groups']> = [];
  for (const raw of summary.evals) {
    let group: Record<string, unknown>;
    try { group = object(raw); } catch { throw new NativeError('invalid-native-eval-summary', 'evidence'); }
    if (typeof group.evalFilePath !== 'string' || typeof group.variant !== 'string' ||
        typeof group.passed !== 'boolean' || typeof group.scoringApplied !== 'boolean' ||
        (group.model !== undefined && typeof group.model !== 'string')) throw new NativeError('invalid-native-eval-summary', 'evidence');
    if (group.scoringApplied && (typeof group.overallScore !== 'number' || !Number.isFinite(group.overallScore) ||
        typeof group.threshold !== 'number' || !Number.isFinite(group.threshold) || group.threshold < 0 || group.threshold > 1)) {
      throw new NativeError('invalid-native-scoring-evidence', 'evidence');
    }
    const key = sha256(JSON.stringify([group.evalFilePath, group.variant, group.model ?? '']));
    if (seen.has(key)) throw new NativeError('duplicate-native-eval-summary', 'evidence');
    seen.add(key);
    const bucket = buckets.get(key) ?? { trials: 0, stimuli: new Set<string>(), skipped: 0 };
    const stimuliRun = count(group.stimuliRun);
    const stimuliTotal = count(group.stimuliTotal);
    const skipped = count(group.stimuliSkipped ?? 0);
    if (stimuliRun !== bucket.stimuli.size || skipped !== bucket.skipped || stimuliRun + skipped > stimuliTotal) {
      throw new NativeError('inconsistent-native-counts', 'evidence');
    }
    if (group.error !== undefined) executionErrors = true;
    const name = bucket.name ?? basename(group.evalFilePath);
    if (!name || name.length > 256 || /[\r\n]/.test(name)) throw new NativeError('invalid-native-eval-name', 'evidence');
    groups.push({ identity: key, name, passed: group.passed, trials: bucket.trials, stimuliRun, stimuliTotal, skipped });
  }
  if ([...buckets.keys()].some((key) => !seen.has(key)) || (summary.passed && groups.some((group) => !group.passed))) {
    throw new NativeError('inconsistent-native-verdict', 'evidence');
  }
  const executed = groups.reduce((total, group) => total + group.trials, 0);
  const base = { completeness: 'complete' as const, executed, nativeRunId: runId, groups };
  if (executionErrors) return { ...base, outcome: 'error', category: 'execution', code: 'native-execution-error' };
  // Never use text matching to reinterpret a nonzero native exit as an empty successful run.
  if (executed === 0 && exitCode === 0 && summary.passed) return { ...base, outcome: 'not-run', category: 'none', code: 'native-empty-selection' };
  if (!summary.passed) return {
    ...base, outcome: 'failed', category: 'none', code: 'native-verdict-failed',
    passed: groups.filter((group) => group.trials > 0 && group.passed).length,
    failed: groups.filter((group) => group.trials > 0 && !group.passed).length,
  };
  if (exitCode !== 0) return { ...base, outcome: 'error', category: 'execution', code: 'native-process-failed' };
  return { ...base, outcome: 'passed', category: 'none', code: 'native-verdict-passed', passed: groups.filter((group) => group.trials > 0).length, failed: 0 };
}

export async function runNative(
  inputs: Inputs, engine: EngineIdentity, cwd: string, directory: string, env: NodeJS.ProcessEnv,
  invoke: Invoke = invokeVally,
): Promise<{ result: NativeResult; files: string[] }> {
  const runId = randomUUID();
  const commands = nativeArguments(inputs, cwd, directory, runId);
  if (sha256(await readFile(engine.entry)) !== engine.sha256) throw new NativeError('engine-executable-changed', 'dependency');
  const version = await invoke(engine, ['--version'], cwd, { ...inertEnvironment(env), HOME: env.HOME, VALLY_TELEMETRY_OPTOUT: '1', DO_NOT_TRACK: '1' }, directory);
  if (version.cancelled) return { result: { outcome: 'cancelled', completeness: 'partial', category: 'execution', code: 'native-cancelled' }, files: [version.stdout, version.stderr] };
  if (version.code !== 0 || (await readFile(version.stdout, 'utf8')).trim() !== engine.version) throw new NativeError('native-version-mismatch', 'dependency');
  const files: string[] = [];
  let result: NativeResult = { outcome: 'validated', completeness: 'unknown', category: 'none', code: 'native-lint-validated', executed: 0 };
  for (const args of commands) {
    const child = await invoke(engine, args, cwd, env, directory);
    files.push(child.stdout, child.stderr);
    if (child.cancelled) return { result: { outcome: 'cancelled', completeness: 'partial', category: 'execution', code: 'native-cancelled' }, files };
    if (inputs.command === 'lint') {
      if (child.code !== 0) result = { outcome: 'error', completeness: 'unknown', category: 'configuration', code: 'native-lint-failed', executed: 0 };
    } else {
      try {
        if ((await stat(child.stdout)).size > 64 * 1024 * 1024) throw new NativeError('native-evidence-exceeds-64mb', 'evidence');
        result = parseNativeEvidence(await readFile(child.stdout, 'utf8'), runId, child.code);
      } catch (error) {
        if (!(error instanceof NativeError)) throw error;
        result = { outcome: 'error', completeness: 'partial', category: error.category, code: error.code, nativeRunId: runId };
      }
    }
  }
  return { result, files };
}

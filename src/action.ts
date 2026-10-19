import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseInputs } from './inputs.js';
import { assertRevision, eventEligibility, inertEnvironment, object, projectDirectory } from './policy.js';
import { NativeError, nativeArguments, nativeEnvironment, runNative } from './native.js';
import { renderSummary, structuredReport, type Report } from './reporting.js';
import { githubClient, ReportingError, takeReportToken, takeSecretInput } from './github.js';
import { postReport } from './reporter.js';
import { acquireEngine, resolveRelease, sha256 } from './tooling.js';

const execute = promisify(execFile);

export async function runAction(): Promise<void> {
  const reportToken = takeReportToken(() => core.getInput('report-token'), process.env, core.setSecret);
  const copilotToken = takeSecretInput('COPILOT-TOKEN', () => core.getInput('copilot-token'), process.env, core.setSecret);
  const report: Report = {
    schemaVersion: 1, command: 'unknown', outcome: 'error', completeness: 'unknown',
    revision: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA! : 'unknown',
    category: 'configuration', code: 'invalid-input-or-context',
  };
  let inputs: ReturnType<typeof parseInputs> | undefined;
  let pullNumber: number | undefined;
  let nativeFiles: string[] = [];
  let nativeDirectory: string | undefined;
  try {
    inputs = parseInputs((name) => core.getInput(name, { trimWhitespace: false }));
    report.command = inputs.command;
    if (inputs.command === 'lint' && (inputs.suite || inputs.evalPaths.length || inputs.tags.length)) {
      core.warning('Lint scans all evals under working-directory. Suite, eval-paths and tags selectors are ignored for lint.');
    }
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Only Linux x64 runners are supported.');
    const payload: unknown = JSON.parse(await readFile(requiredEnv('GITHUB_EVENT_PATH'), 'utf8'));
    if (eventEligibility(requiredEnv('GITHUB_EVENT_NAME'), payload, requiredEnv('GITHUB_REPOSITORY')) === 'fork') {
      report.outcome = 'not-run';
      report.category = 'policy';
      report.code = 'fork-execution-excluded';
      report.executed = 0;
      core.warning('Fork pull requests are excluded. No evaluator or installer was started.');
    } else {
      const cwd = await projectDirectory(requiredEnv('GITHUB_WORKSPACE'), inputs.workingDirectory);
      const revision = await execute('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
        env: inertEnvironment(process.env), timeout: 10_000, maxBuffer: 4096,
      });
      assertRevision(revision.stdout, requiredEnv('GITHUB_SHA'));
      if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
        const number = object(payload).number;
        if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) pullNumber = number;
      }
      nativeDirectory = await mkdtemp(join(requiredEnv('RUNNER_TEMP'), 'evals-native-'));
      nativeArguments(inputs, cwd, nativeDirectory, 'selection-check');
      const home = join(nativeDirectory, 'home');
      await mkdir(home, { mode: 0o700 });
      const env = nativeEnvironment(inputs, process.env, home, reportToken, copilotToken);
      const tools = join(requiredEnv('RUNNER_TEMP'), `evals-tools-${sha256(JSON.stringify([
        requiredEnv('GITHUB_RUN_ID'), requiredEnv('GITHUB_RUN_ATTEMPT'), requiredEnv('GITHUB_JOB'),
      ]))}`);
      report.category = 'dependency';
      report.code = 'vally-acquisition-failed';
      const release = await resolveRelease(inputs.vallyVersion, tools);
      const engine = await acquireEngine(release, tools);
      report.engine = {
        version: engine.version, sha256: engine.sha256,
        dependencySha256: engine.dependencySha256, lockSha256: engine.lockSha256,
      };
      report.category = 'execution';
      report.code = 'vally-execution-failed';
      const current = await execute('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
        env: inertEnvironment(process.env), timeout: 10_000, maxBuffer: 4096,
      });
      assertRevision(current.stdout, requiredEnv('GITHUB_SHA'));
      if (await projectDirectory(requiredEnv('GITHUB_WORKSPACE'), inputs.workingDirectory) !== cwd) throw new NativeError('project-directory-changed', 'policy');
      const operation = await runNative(inputs, engine, cwd, nativeDirectory, env);
      nativeFiles = operation.files;
      Object.assign(report, operation.result);
    }
  } catch (error) {
    report.outcome = 'error';
    if (error instanceof NativeError) { report.category = error.category; report.code = error.code; }
  }
  if (report.outcome === 'error' || report.outcome === 'failed' || report.outcome === 'cancelled') core.setFailed(`Evals ${report.outcome}: ${report.code}. See the documented command requirements and local native diagnostics.`);
  if (report.code === 'native-empty-selection') core.warning('Native evidence reports zero executed trials. This is not an evaluation pass.');
  core.setOutput('outcome', report.outcome);
  core.setOutput('plan-completeness', report.completeness);
  if (report.executed !== undefined) core.setOutput('executed', report.executed);
  if (report.passed !== undefined) core.setOutput('passed', report.passed);
  if (report.failed !== undefined) core.setOutput('failed', report.failed);
  if (report.engine) core.setOutput('vally-version', report.engine.version);
  if (nativeDirectory) core.setOutput('native-diagnostics-path', nativeDirectory);
  await core.summary.addRaw(renderSummary(report)).write();
  const directory = await mkdtemp(join(requiredEnv('RUNNER_TEMP'), 'evals-report-'));
  const path = join(directory, 'report.json');
  await writeFile(path, structuredReport(report), { mode: 0o600 });
  core.setOutput('result-path', path);
  const artifact = await new DefaultArtifactClient().uploadArtifact(
    `evals-${inputs?.reportId ?? 'invalid'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${directory.slice(-6)}`,
    [path], directory, { retentionDays: inputs?.retentionDays ?? 7 },
  );
  if (artifact.id !== undefined) core.setOutput('artifact-id', artifact.id);
  if (inputs?.uploadTranscripts && nativeDirectory && nativeFiles.length) {
    core.warning('Opt-in native JSONL/logs may contain prompts, source, tool output and secrets. Perfect redaction is not guaranteed.');
    try {
      for (const file of nativeFiles) {
        if (!(await lstat(file)).isFile()) throw new Error('Native transcript is not a regular file.');
      }
      await new DefaultArtifactClient().uploadArtifact(
        `evals-transcripts-${inputs.reportId}-${directory.slice(-6)}`, nativeFiles, nativeDirectory,
        { retentionDays: inputs.retentionDays },
      );
    } catch {
      core.warning('Optional transcript upload failed. The native operation outcome is unchanged.');
    }
  }
  if (inputs?.comment) {
    let warning: string | undefined;
    if (pullNumber === undefined) {
      warning = 'comment-context-excluded: only a verified same-repository pull request can receive a report.';
    } else {
      try {
        const outcome = await postReport(githubClient(reportToken, requiredEnv('RUNNER_TEMP')), {
          repository: requiredEnv('GITHUB_REPOSITORY'), workflowRef: requiredEnv('GITHUB_WORKFLOW_REF'),
          workflowSha: requiredEnv('GITHUB_WORKFLOW_SHA'), job: requiredEnv('GITHUB_JOB'), reportId: inputs.reportId,
          selection: sha256(JSON.stringify(inputs.command === 'lint'
            ? ['lint', inputs.workingDirectory]
            : [inputs.suite ?? '', inputs.evalPaths, inputs.tags])),
          pullNumber, runId: Number(requiredEnv('GITHUB_RUN_ID')),
          order: { runNumber: Number(requiredEnv('GITHUB_RUN_NUMBER')), attempt: Number(requiredEnv('GITHUB_RUN_ATTEMPT')) },
        }, report, artifact.id);
        if (outcome === 'stale') warning = 'stale-report-skipped: a newer run or attempt already owns the report.';
      } catch (error) {
        warning = `${error instanceof ReportingError ? error.code : 'comment-reporting-failed'}: optional PR reporting did not complete.`;
      }
    }
    if (warning) {
      core.warning(warning);
      try {
        await core.summary.addRaw(`\nReporting warning: ${warning} The operation outcome is unchanged.\n`).write();
      } catch {
        core.warning('Optional PR reporting warning could not be appended to the summary. The operation outcome is unchanged.');
      }
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is missing.`);
  return value;
}

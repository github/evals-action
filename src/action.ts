import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseInputs } from './inputs.js';
import { assertRevision, containedFile, eventEligibility, inertEnvironment, object, projectDirectory } from './policy.js';
import { NativeError, nativeArguments, nativeEnvironment, runNative } from './native.js';
import { parseStructuredReport, renderSummary, structuredReport, type Report } from './reporting.js';
import { githubClient, ReportingError, takeReportToken, takeSecretInput } from './github.js';
import { postReport } from './reporter.js';
import { acquireEngine, resolveRelease, sha256 } from './tooling.js';

const execute = promisify(execFile);

export async function runAction(): Promise<void> {
  const reportToken = takeReportToken(() => core.getInput('report-token'), process.env, core.setSecret);
  const copilotToken = takeSecretInput('COPILOT-TOKEN', () => core.getInput('copilot-token'), process.env, core.setSecret);
  const report: Report = {
    schemaVersion: 2, reportId: 'invalid', repository: process.env.GITHUB_REPOSITORY ?? 'unknown/unknown',
    workflowRunId: Number(process.env.GITHUB_RUN_ID ?? 0), workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
    sourceJob: process.env.GITHUB_JOB ?? 'unknown', selection: '0'.repeat(64),
    command: 'unknown', outcome: 'error', completeness: 'unknown',
    revision: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA! : 'unknown',
    category: 'configuration', code: 'invalid-input-or-context',
  };
  let inputs: ReturnType<typeof parseInputs> | undefined;
  let reportMode = core.getInput('command').trim() === 'report';
  let pullNumber: number | undefined;
  let nativeFiles: string[] = [];
  let nativeDirectory: string | undefined;
  try {
    inputs = parseInputs((name) => core.getInput(name, { trimWhitespace: false }));
    reportMode = inputs.command === 'report';
    report.command = inputs.command;
    report.reportId = inputs.reportId;
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
      if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
        const number = object(payload).number;
        if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) pullNumber = number;
      }
      if (inputs.command === 'report') {
        if (copilotToken || inputs.credentialEnv.length || inputs.suite || inputs.evalPaths.length || inputs.tags.length ||
            Object.keys(inputs.overrides).length || inputs.uploadTranscripts || inputs.workingDirectory) {
          throw new NativeError('report-command-does-not-accept-execution-inputs', 'configuration');
        }
        if (pullNumber === undefined) throw new NativeError('report-command-requires-pull-request', 'policy');
        if (inputs.sourceArtifactId === undefined || inputs.sourceArtifactDigest === undefined) {
          throw new NativeError('source-artifact-identity-required', 'configuration');
        }
        const downloadDirectory = await mkdtemp(join(requiredEnv('RUNNER_TEMP'), 'evals-report-download-'));
        let imported: Report;
        try {
          const download = await new DefaultArtifactClient().downloadArtifact(inputs.sourceArtifactId, {
            path: downloadDirectory, expectedHash: `sha256:${inputs.sourceArtifactDigest}`,
          });
          if (download.digestMismatch || download.downloadPath === undefined) {
            throw new NativeError('source-artifact-digest-mismatch', 'evidence');
          }
          const entries = await readdir(downloadDirectory);
          if (entries.length !== 1 || entries[0] !== 'report.json') {
            throw new NativeError('source-artifact-content-invalid', 'evidence');
          }
          const path = await containedFile(downloadDirectory, 'report.json', 1024 * 1024);
          imported = parseStructuredReport(await readFile(path, 'utf8'), {
            reportId: inputs.reportId, repository: requiredEnv('GITHUB_REPOSITORY'),
            workflowRunId: positiveEnv('GITHUB_RUN_ID'), workflowRunAttempt: positiveEnv('GITHUB_RUN_ATTEMPT'),
            revision: requiredEnv('GITHUB_SHA'),
          });
        } finally {
          await rm(downloadDirectory, { recursive: true, force: true });
        }
        Object.assign(report, imported);
        try {
          const outcome = await postReport(githubClient(reportToken, requiredEnv('RUNNER_TEMP')), {
            repository: report.repository, workflowRef: requiredEnv('GITHUB_WORKFLOW_REF'),
            workflowSha: requiredEnv('GITHUB_WORKFLOW_SHA'), job: requiredEnv('GITHUB_JOB'), reportId: report.reportId,
            ...(process.env.EVALS_JOB_WORKFLOW_REF || process.env.EVALS_JOB_WORKFLOW_SHA ||
                process.env.EVALS_JOB_WORKFLOW_REPOSITORY || process.env.EVALS_JOB_WORKFLOW_FILE_PATH
              ? { reusableWorkflow: {
                ref: process.env.EVALS_JOB_WORKFLOW_REF ?? '',
                sha: process.env.EVALS_JOB_WORKFLOW_SHA ?? '',
                repository: process.env.EVALS_JOB_WORKFLOW_REPOSITORY ?? '',
                filePath: process.env.EVALS_JOB_WORKFLOW_FILE_PATH ?? '',
              } } : {}),
            selection: report.selection, pullNumber, runId: report.workflowRunId,
            order: { runNumber: positiveEnv('GITHUB_RUN_NUMBER'), attempt: report.workflowRunAttempt },
          }, report, inputs.sourceArtifactId);
          if (outcome === 'stale') core.warning('A newer run or attempt already owns this report comment.');
        } catch (error) {
          throw new NativeError(error instanceof ReportingError ? error.code : 'comment-reporting-failed', 'execution');
        }
        publishOutputs(report);
        await core.summary.addRaw(renderSummary(report)).write();
        return;
      }
      if (reportToken) throw new NativeError('report-token-only-valid-for-report', 'configuration');
      const cwd = await projectDirectory(requiredEnv('GITHUB_WORKSPACE'), inputs.workingDirectory);
      const revision = await execute('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
        env: inertEnvironment(process.env), timeout: 10_000, maxBuffer: 4096,
      });
      assertRevision(revision.stdout, requiredEnv('GITHUB_SHA'));
      report.selection = sha256(JSON.stringify(inputs.command === 'lint'
        ? ['lint', inputs.workingDirectory]
        : [inputs.suite ?? '', inputs.evalPaths, inputs.tags]));
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
  publishOutputs(report);
  if (reportMode) {
    await core.summary.addRaw(renderSummary(report)).write();
    return;
  }
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
  if (artifact.id === undefined || artifact.digest === undefined) {
    core.setFailed('Evals evidence upload did not return an artifact ID and digest.');
    return;
  }
  core.setOutput('artifact-id', artifact.id);
  core.setOutput('artifact-digest', artifact.digest);
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
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is missing.`);
  return value;
}

function positiveEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new NativeError(`invalid-${name.toLowerCase().replaceAll('_', '-')}`, 'policy');
  return value;
}

function publishOutputs(report: Report): void {
  core.setOutput('outcome', report.outcome);
  core.setOutput('plan-completeness', report.completeness);
  if (report.executed !== undefined) core.setOutput('executed', report.executed);
  if (report.passed !== undefined) core.setOutput('passed', report.passed);
  if (report.failed !== undefined) core.setOutput('failed', report.failed);
  if (report.engine) core.setOutput('vally-version', report.engine.version);
}

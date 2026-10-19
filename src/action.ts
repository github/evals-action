import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseInputs, type Inputs } from './inputs.js';
import { assertRevision, containedFile, eventEligibility, inertEnvironment, object, projectDirectory } from './policy.js';
import { NativeError, nativeArguments, nativeEnvironment, runNative } from './native.js';
import { parseStructuredReport, renderSummary, structuredReport, type Report } from './reporting.js';
import { githubClient, ReportingError, takeReportToken, takeSecretInput } from './github.js';
import { postReport } from './reporter.js';
import { acquireEngine, resolveRelease, sha256 } from './tooling.js';

const execute = promisify(execFile);
type Evidence = { report: Report; artifactId: number };

export async function runAction(): Promise<void> {
  const githubToken = takeSecretInput('GITHUB-TOKEN', () => core.getInput('github-token'), process.env, core.setSecret);
  const reportToken = takeReportToken(() => core.getInput('report-token'), process.env, core.setSecret);
  const copilotToken = takeSecretInput('COPILOT-TOKEN', () => core.getInput('copilot-token'), process.env, core.setSecret);
  const requestedCommand = core.getInput('command').trim() || 'all';
  const reportMode = requestedCommand === 'report';
  const allMode = requestedCommand === 'all';
  const id = core.getInput('report-id').trim() || 'evals';
  const report: Report = {
    schemaVersion: 2, reportId: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) ? id : 'invalid',
    repository: process.env.GITHUB_REPOSITORY ?? 'unknown/unknown',
    workflowRunId: Number(process.env.GITHUB_RUN_ID ?? 0), workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
    sourceJob: process.env.GITHUB_JOB ?? 'unknown', selection: '0'.repeat(64),
    command: allMode ? 'lint' : requestedCommand, outcome: 'error', completeness: 'unknown',
    revision: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA! : 'unknown',
    category: 'configuration', code: 'invalid-input-or-context',
  };
  let inputs: Inputs | undefined;
  let pullNumber: number | undefined;
  let companion: Evidence | undefined;
  const nativeFiles: string[] = [];
  let nativeDirectory: string | undefined;
  try {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Only Linux x64 runners are supported.');
    const payload: unknown = JSON.parse(await readFile(requiredEnv('GITHUB_EVENT_PATH'), 'utf8'));
    const eligibility = eventEligibility(requiredEnv('GITHUB_EVENT_NAME'), payload, requiredEnv('GITHUB_REPOSITORY'));
    if (eligibility === 'fork') {
      core.warning('Fork pull requests are excluded. No evaluator, installer, or commenter was started.');
      Object.assign(report, { outcome: 'not-run', category: 'policy', code: 'fork-execution-excluded', executed: 0 });
      publishOutputs(report);
      await core.summary.addRaw(renderSummary(report)).write();
      if (!reportMode) {
        try { publishArtifactOutputs(await uploadReport(report, 7)); }
        catch { core.setFailed('Required structured reporting failed: artifact upload did not complete.'); }
      }
      return;
    }
    if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      const number = object(payload).number;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
        throw new NativeError('invalid-pull-request-number', 'policy');
      }
      pullNumber = number;
    }
    inputs = parseInputs((name) => core.getInput(name, { trimWhitespace: false }));
    report.reportId = inputs.reportId;
    if (reportMode) {
      if (copilotToken || inputs.credentialEnv.length || inputs.suite || inputs.evalPaths.length || inputs.tags.length ||
          Object.keys(inputs.overrides).length || inputs.uploadTranscripts || inputs.workingDirectory) {
        throw new NativeError('report-command-does-not-accept-execution-inputs', 'configuration');
      }
      if (pullNumber === undefined) throw new NativeError('report-command-requires-pull-request', 'policy');
      if (inputs.sourceArtifactId === undefined || !inputs.sourceArtifactDigest) {
        throw new NativeError('source-artifact-identity-required', 'configuration');
      }
      const imported = await readReportArtifact(inputs.sourceArtifactId, inputs.sourceArtifactDigest, inputs.reportId);
      if (inputs.lintArtifactId !== undefined) {
        if (!inputs.lintArtifactDigest) throw new NativeError('lint-artifact-identity-required', 'configuration');
        companion = {
          report: await readReportArtifact(inputs.lintArtifactId, inputs.lintArtifactDigest, `${reportPrefix(inputs.reportId)}-lint`),
          artifactId: inputs.lintArtifactId,
        };
      }
      await commentReport(imported, reportToken || githubToken, pullNumber, inputs.sourceArtifactId, companion);
      publishOutputs(imported);
      await core.summary.addRaw(renderSummary(imported)).write();
      return;
    }

    if (!allMode && reportToken) throw new NativeError('report-token-only-valid-for-all-or-report', 'configuration');
    if (inputs.command === 'lint' && (inputs.suite || inputs.evalPaths.length || inputs.tags.length)) {
      core.warning('Lint scans all evals under working-directory. Suite, eval-paths and tags selectors are ignored for lint.');
    }
    const cwd = await projectDirectory(requiredEnv('GITHUB_WORKSPACE'), inputs.workingDirectory);
    await verifyCheckout(cwd);
    nativeDirectory = await mkdtemp(join(requiredEnv('RUNNER_TEMP'), 'evals-native-'));
    const home = join(nativeDirectory, 'home');
    await mkdir(home, { mode: 0o700 });
    const executionInputs: Inputs = allMode
      ? { ...inputs, command: 'run', overrides: { maxRetries: 0, ...inputs.overrides } }
      : inputs;
    // Validate selection and credentials before acquisition or lint effects.
    nativeArguments(executionInputs, cwd, nativeDirectory, 'selection-check');
    const env = nativeEnvironment(executionInputs, process.env, home, allMode ? '' : reportToken,
      copilotToken || (allMode && inputs.credentialEnv.length === 0 ? githubToken : ''));
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
    await verifyCheckout(cwd);
    if (await projectDirectory(requiredEnv('GITHUB_WORKSPACE'), inputs.workingDirectory) !== cwd) {
      throw new NativeError('project-directory-changed', 'policy');
    }
    report.category = 'execution';
    report.code = 'vally-execution-failed';
    report.selection = sha256(JSON.stringify(['lint', inputs.workingDirectory]));
    if (allMode) {
      const lintInputs: Inputs = { ...inputs, command: 'lint', evalPaths: [], tags: [], overrides: {}, credentialEnv: [] };
      delete lintInputs.suite;
      const lint = await runNative(lintInputs, engine, cwd, nativeDirectory, nativeEnvironment(lintInputs, process.env, home, ''));
      nativeFiles.push(...lint.files);
      Object.assign(report, lint.result);
      if (report.outcome === 'validated') {
        const lintReport = { ...report, reportId: `${reportPrefix(inputs.reportId)}-lint` };
        const saved = await uploadReport(lintReport, inputs.retentionDays);
        companion = { report: lintReport, artifactId: saved.id };
        core.setOutput('lint-artifact-id', saved.id);
        core.setOutput('lint-artifact-digest', saved.digest);
        report.category = 'policy';
        report.code = 'checkout-revision-changed';
        await verifyCheckout(cwd);
        if (await projectDirectory(requiredEnv('GITHUB_WORKSPACE'), inputs.workingDirectory) !== cwd) {
          throw new NativeError('project-directory-changed', 'policy');
        }
      }
    }
    if (!allMode || report.outcome === 'validated') {
      report.command = executionInputs.command;
      report.outcome = 'error';
      report.completeness = 'unknown';
      report.code = 'vally-execution-failed';
      report.category = 'execution';
      delete report.executed;
      if (executionInputs.command === 'run') {
        report.selection = sha256(JSON.stringify([inputs.suite ?? '', inputs.evalPaths, inputs.tags]));
        if (inputs.suite) report.suite = inputs.suite;
      }
      const operation = await runNative(executionInputs, engine, cwd, nativeDirectory, env);
      nativeFiles.push(...operation.files);
      Object.assign(report, operation.result);
    }
  } catch (error) {
    report.outcome = 'error';
    if (error instanceof NativeError) { report.category = error.category; report.code = error.code; }
  }

  if (['error', 'failed', 'cancelled'].includes(report.outcome)) {
    core.setFailed(`Evals ${report.outcome}: ${report.code}. See the documented command requirements and local native diagnostics.`);
  }
  if (report.code === 'native-empty-selection') core.warning('Native evidence reports zero executed trials. This is not an evaluation pass.');
  publishOutputs(report);
  await core.summary.addRaw(renderSummary(report)).write();
  if (reportMode) return;
  if (nativeDirectory) core.setOutput('native-diagnostics-path', nativeDirectory);
  let artifactId: number | undefined;
  try {
    const artifact = await uploadReport(report, inputs?.retentionDays ?? 7);
    artifactId = artifact.id;
    publishArtifactOutputs(artifact);
  } catch {
    core.setFailed('Required structured reporting failed: artifact upload did not complete.');
  }
  if (allMode && pullNumber !== undefined) {
    try {
      await commentReport(report, reportToken || githubToken, pullNumber, artifactId, companion);
    } catch (error) {
      core.setFailed(`Evals PR reporting failed: ${error instanceof NativeError ? error.code : 'comment-reporting-failed'}.`);
    }
  }
  if (inputs?.uploadTranscripts && nativeDirectory && nativeFiles.length) {
    core.warning('Opt-in native JSONL/logs may contain prompts, source, tool output and secrets. Perfect redaction is not guaranteed.');
    try {
      for (const file of nativeFiles) {
        if (!(await lstat(file)).isFile()) throw new Error('Native transcript is not a regular file.');
      }
      await new DefaultArtifactClient().uploadArtifact(
        `evals-transcripts-${inputs.reportId}-${nativeDirectory.slice(-6)}`, nativeFiles, nativeDirectory,
        { retentionDays: inputs.retentionDays },
      );
    } catch {
      core.warning('Optional transcript upload failed. The native operation outcome is unchanged.');
    }
  }
}

function reportPrefix(id: string): string { return id.replace(/-(?:lint|run)$/, ''); }

async function commentReport(report: Report, token: string, pullNumber: number, artifactId?: number, companion?: Evidence): Promise<void> {
  try {
    const outcome = await postReport(githubClient(token, requiredEnv('RUNNER_TEMP')), {
      repository: report.repository, workflowRef: requiredEnv('GITHUB_WORKFLOW_REF'),
      workflowSha: requiredEnv('GITHUB_WORKFLOW_SHA'), job: requiredEnv('GITHUB_JOB'),
      reportId: reportPrefix(report.reportId), selection: report.selection,
      pullNumber, runId: report.workflowRunId,
      order: { runNumber: positiveEnv('GITHUB_RUN_NUMBER'), attempt: report.workflowRunAttempt },
    }, report, artifactId, companion);
    if (outcome === 'stale') core.warning('A newer run or attempt already owns this report comment.');
  } catch (error) {
    throw new NativeError(error instanceof ReportingError ? error.code : 'comment-reporting-failed', 'execution');
  }
}

async function verifyCheckout(cwd: string): Promise<void> {
  const revision = await execute('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    env: inertEnvironment(process.env), timeout: 10_000, maxBuffer: 4096,
  });
  assertRevision(revision.stdout, requiredEnv('GITHUB_SHA'));
}

async function uploadReport(report: Report, retentionDays: number): Promise<{ id: number; digest: string; path: string }> {
  const directory = await mkdtemp(join(requiredEnv('RUNNER_TEMP'), 'evals-report-'));
  const path = join(directory, 'report.json');
  await writeFile(path, structuredReport(report), { mode: 0o600 });
  let artifact;
  try {
    artifact = await new DefaultArtifactClient().uploadArtifact(
      `evals-${report.reportId}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${directory.slice(-6)}`,
      [path], directory, { retentionDays },
    );
  } catch {
    throw new NativeError('structured-artifact-upload-failed', 'evidence');
  }
  if (!artifact.id || !artifact.digest) throw new NativeError('artifact-identity-missing', 'evidence');
  return { id: artifact.id, digest: artifact.digest, path };
}

async function readReportArtifact(artifactId: number, digest: string, reportId: string): Promise<Report> {
  const directory = await mkdtemp(join(requiredEnv('RUNNER_TEMP'), 'evals-report-download-'));
  try {
    const download = await new DefaultArtifactClient().downloadArtifact(artifactId, { path: directory, expectedHash: `sha256:${digest}` });
    if (download.digestMismatch || download.downloadPath !== directory) throw new NativeError('source-artifact-digest-mismatch', 'evidence');
    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== 'report.json') throw new NativeError('source-artifact-content-invalid', 'evidence');
    const path = await containedFile(directory, 'report.json', 1024 * 1024);
    return parseStructuredReport(await readFile(path, 'utf8'), {
      reportId, repository: requiredEnv('GITHUB_REPOSITORY'), workflowRunId: positiveEnv('GITHUB_RUN_ID'),
      workflowRunAttempt: positiveEnv('GITHUB_RUN_ATTEMPT'), revision: requiredEnv('GITHUB_SHA'),
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
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

function publishArtifactOutputs(artifact: { id: number; digest: string; path: string }): void {
  core.setOutput('result-path', artifact.path);
  core.setOutput('artifact-id', artifact.id);
  core.setOutput('artifact-digest', artifact.digest);
}

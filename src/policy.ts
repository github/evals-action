import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}

export function eventEligibility(eventName: string, payload: unknown, repository: string): 'eligible' | 'fork' {
  if (eventName === 'pull_request_target') throw new Error('pull_request_target is not supported.');
  if (eventName === 'pull_request') {
    const event = object(payload);
    const pull = object(event.pull_request);
    const head = object(object(pull.head).repo);
    const base = object(object(pull.base).repo);
    if (typeof head.full_name !== 'string' || typeof base.full_name !== 'string' || base.full_name !== repository) {
      throw new Error('Cannot establish pull request repository identity.');
    }
    return head.full_name === repository && head.fork === false ? 'eligible' : 'fork';
  }
  if (eventName !== 'push' && eventName !== 'workflow_dispatch') throw new Error('Unsupported workflow event.');
  return 'eligible';
}

export function assertRevision(actual: string, expected: string): void {
  if (!/^[a-f0-9]{40}$/.test(expected) || actual.trim() !== expected) throw new Error('Checkout revision does not match GITHUB_SHA.');
}

export async function projectDirectory(workspace: string, input: string): Promise<string> {
  if (isAbsolute(input)) throw new Error('working-directory must be relative to the workspace.');
  const root = await realpath(workspace);
  const project = await realpath(resolve(root, input));
  const rel = relative(root, project);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(project)).isDirectory()) {
    throw new Error('working-directory must resolve to a directory inside the workspace.');
  }
  return project;
}

export async function containedFile(directory: string, input: string, maximumBytes: number): Promise<string> {
  if (!input || isAbsolute(input)) throw new Error('File path must be relative to its trusted directory.');
  const root = await realpath(directory);
  const file = await realpath(resolve(root, input));
  const rel = relative(root, file);
  const info = await stat(file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !info.isFile() || info.size > maximumBytes) {
    throw new Error('File path must resolve to a bounded regular file inside its trusted directory.');
  }
  return file;
}

// An allowlist is deliberate: no evaluator, reporting, npm, Git or Node injection variables.
// This is process hygiene, not isolation from other processes under the same runner user.
export function inertEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL',
    'VALLY_TELEMETRY_OPTOUT', 'DO_NOT_TRACK', 'OTEL_SDK_DISABLED',
  ]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  result.CI = 'true';
  return result;
}

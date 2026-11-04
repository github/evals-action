import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRevision, containedFile, eventEligibility, inertEnvironment, object, projectDirectory } from '../src/policy.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('trust and inert operations', () => {
  it('rejects privileged or unknown events', () => {
    for (const name of ['pull_request_target', 'issue_comment', 'schedule']) expect(() => eventEligibility(name, {}, 'o/r')).toThrow();
    for (const name of ['push', 'workflow_dispatch']) expect(eventEligibility(name, {}, 'o/r')).toBe('eligible');
  });
  it('excludes forks and requires exact base identity', () => {
    const payload = (name: string, fork: boolean, base = 'o/r') => ({
      pull_request: { head: { repo: { full_name: name, fork } }, base: { repo: { full_name: base } } },
    });
    expect(eventEligibility('pull_request', payload('o/r', false), 'o/r')).toBe('eligible');
    expect(eventEligibility('pull_request', payload('other/r', true), 'o/r')).toBe('fork');
    expect(eventEligibility('pull_request', payload('o/r', true), 'o/r')).toBe('fork');
    expect(() => eventEligibility('pull_request', payload('o/r', false, 'other/r'), 'o/r')).toThrow();
    expect(() => eventEligibility('pull_request', {}, 'o/r')).toThrow();
  });
  it('does not inherit model or reporting credentials and injection variables', () => {
    expect(inertEnvironment({
      PATH: '/usr/bin', LANG: 'C', HOME: '/home/runner', COPILOT_GITHUB_TOKEN: 'model',
      GITHUB_TOKEN: 'report', NODE_OPTIONS: '--require malicious', NPM_TOKEN: 'secret',
      npm_config_userconfig: 'malicious', GIT_CONFIG_COUNT: '1', ACTIONS_RUNTIME_TOKEN: 'artifact',
    })).toEqual({ PATH: '/usr/bin', LANG: 'C', CI: 'true' });
  });
  it('preserves only the named caller telemetry controls without interpreting their values', () => {
    for (const value of ['1', '0', 'true', 'false', '']) {
      const controls = { VALLY_TELEMETRY_OPTOUT: value, DO_NOT_TRACK: value, OTEL_SDK_DISABLED: value };
      expect(inertEnvironment({
        ...controls, GITHUB_TOKEN: 'report', COPILOT_GITHUB_TOKEN: 'model', NODE_OPTIONS: 'unsafe',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://untrusted.invalid', OTEL_EXPORTER_OTLP_HEADERS: 'private-header',
        OTEL_RESOURCE_ATTRIBUTES: 'private-attributes',
      })).toEqual({ ...controls, CI: 'true' });
    }
    expect(inertEnvironment({})).toEqual({ CI: 'true' });
  });
  it('checks immutable checkout identity without claiming authorization', () => {
    assertRevision(`${'a'.repeat(40)}\n`, 'a'.repeat(40));
    expect(() => assertRevision('a'.repeat(40), 'b'.repeat(40))).toThrow();
    expect(() => assertRevision('main', 'main')).toThrow();
  });
  it('contains paths including symlinks and preserves spaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evals-policy-')); directories.push(root);
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, 'with spaces'), { recursive: true });
    await mkdir(join(root, 'outside'));
    await writeFile(join(workspace, 'file'), '');
    await symlink(join(root, 'outside'), join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await projectDirectory(workspace, 'with spaces')).toBe(join(workspace, 'with spaces'));
    expect(await projectDirectory(workspace, '.')).toBe(workspace);
    await expect(projectDirectory(workspace, '../outside')).rejects.toThrow(/inside/);
    await expect(projectDirectory(workspace, 'link')).rejects.toThrow(/inside/);
    await expect(projectDirectory(workspace, 'file')).rejects.toThrow(/inside/);
    await expect(projectDirectory(workspace, root)).rejects.toThrow(/relative/);
    await expect(projectDirectory(workspace, 'missing')).rejects.toThrow();
  });
  it('contains downloaded report files and rejects directories, symlink escapes and oversized files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evals-report-policy-')); directories.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await mkdir(join(workspace, 'reports'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(workspace, 'reports', 'report.json'), '{}');
    await writeFile(join(workspace, 'reports', 'large.json'), '12345');
    await writeFile(join(outside, 'report.json'), '{}');
    await symlink(outside, join(workspace, 'reports', 'escape-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await containedFile(workspace, 'reports/report.json', 4)).toBe(join(workspace, 'reports', 'report.json'));
    await expect(containedFile(workspace, 'reports', 100)).rejects.toThrow(/regular file/);
    await expect(containedFile(workspace, 'reports/large.json', 4)).rejects.toThrow(/bounded/);
    await expect(containedFile(workspace, 'reports/escape-dir/report.json', 100)).rejects.toThrow(/trusted directory/);
    await expect(containedFile(workspace, '../outside/report.json', 100)).rejects.toThrow(/trusted directory/);
  });
  it('rejects malformed object boundaries', () => {
    expect(() => object(null)).toThrow();
    expect(() => object([])).toThrow();
    expect(() => object('text')).toThrow();
  });
});

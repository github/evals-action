import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { githubClient, takeReportToken, takeSecretInput } from '../src/github.js';
import { inertEnvironment } from '../src/policy.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'evals-api-')); directories.push(root); return root;
}

it('masks and removes the reporting credential from ambient input, never parsed config or children', () => {
  const env = { 'INPUT_REPORT-TOKEN': 'synthetic-token', COPILOT_GITHUB_TOKEN: 'model', GITHUB_TOKEN: 'automatic', PATH: '/bin' };
  const mask = vi.fn();
  const token = takeReportToken(() => env['INPUT_REPORT-TOKEN'], env, mask);
  expect(token).toBe('synthetic-token');
  expect(mask).toHaveBeenCalledWith(token);
  expect(env).not.toHaveProperty('INPUT_REPORT-TOKEN');
  expect(inertEnvironment(env)).toEqual({ PATH: '/bin', CI: 'true' });
  expect(takeReportToken(() => '', {}, mask)).toBe('');
  const copilotEnvironment = { 'INPUT_COPILOT-TOKEN': 'copilot-token' };
  expect(takeSecretInput('COPILOT-TOKEN', () => 'copilot-token', copilotEnvironment, mask)).toBe('copilot-token');
  expect(copilotEnvironment).not.toHaveProperty('INPUT_COPILOT-TOKEN');
  expect(mask).toHaveBeenCalledWith('copilot-token');
  expect(() => githubClient('', '/tmp')).toThrow(/report-token-required/);
});

it('transports a UTF-8 file-based body with token only in the fixed-host Authorization header', async () => {
  const root = await temporary();
  const body = { body: 'Table | `code`\nUnicode: \u2713\n$variable & <text>' };
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    expect(url).toBe('https://api.github.com/repos/o/r/issues/1/comments');
    expect(options?.redirect).toBe('error');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
    expect(options?.body).toBe(JSON.stringify(body));
    const children = await readdir(root);
    expect(children).toHaveLength(1);
    const bytes = await readFile(join(root, children[0]!, 'request.json'));
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString('utf8')).toBe(JSON.stringify(body));
    expect(bytes.toString('utf8')).not.toContain('synthetic-token');
    return new Response('{"id":1}', { status: 200 });
  });
  const client = githubClient('synthetic-token', root, fetcher);
  expect(await client.request('POST', '/repos/o/r/issues/1/comments', body)).toEqual({ id: 1 });
  expect(await readdir(root)).toEqual([]);
});

it('never retries ambiguous mutations and sanitizes failures while cleaning request files', async () => {
  const root = await temporary();
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('secret in transport message'); });
  await expect(githubClient('synthetic-token', root, fetcher).request('PATCH', '/repos/o/r/issues/comments/1', { body: 'report' }))
    .rejects.toThrow('github-request-failed');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await readdir(root)).toEqual([]);
  const denied = vi.fn<typeof fetch>(async () => new Response('private response', { status: 403 }));
  const client = githubClient('synthetic-token', root, denied);
  await expect(client.request('GET', '/user')).rejects.toThrow('github-http-403');
  await expect(client.request('GET', '//attacker.example')).rejects.toThrow('invalid-github-route');
  expect(denied).toHaveBeenCalledTimes(1);
});

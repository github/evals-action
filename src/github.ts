import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface GitHubClient {
  request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: Record<string, unknown>): Promise<unknown>;
}

export class ReportingError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export function takeSecretInput(
  name: string,
  read: () => string, environment: NodeJS.ProcessEnv, mask: (token: string) => void,
): string {
  const token = read().trim();
  if (token) mask(token);
  delete environment[`INPUT_${name.toUpperCase()}`];
  return token;
}

export function takeReportToken(
  read: () => string, environment: NodeJS.ProcessEnv, mask: (token: string) => void,
): string {
  return takeSecretInput('REPORT-TOKEN', read, environment, mask);
}

export function githubClient(token: string, temporaryDirectory: string, fetcher: typeof fetch = fetch): GitHubClient {
  if (!token) throw new ReportingError('report-token-required');
  return {
    async request(method, path, body) {
      if (!path.startsWith('/') || path.startsWith('//')) throw new ReportingError('invalid-github-route');
      let directory: string | undefined;
      let file: string | undefined;
      try {
        let content: string | undefined;
        if (body !== undefined) {
          directory = await mkdtemp(join(temporaryDirectory, 'evals-github-'));
          file = join(directory, 'request.json');
          await writeFile(file, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
          content = await readFile(file, 'utf8');
        }
        const response = await fetcher(`https://api.github.com${path}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'github-evals-action',
            ...(content !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(content !== undefined ? { body: content } : {}),
        });
        if (!response.ok) throw new ReportingError(`github-http-${response.status}`);
        const value: unknown = await response.json();
        return value;
      } catch (error) {
        // Never surface response bodies, URLs, headers or arbitrary transport exception text.
        throw error instanceof ReportingError ? error : new ReportingError('github-request-failed');
      } finally {
        if (file) await unlink(file);
        if (directory) await rmdir(directory);
      }
    },
  };
}

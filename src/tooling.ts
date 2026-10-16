import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exactVersion } from './inputs.js';
import { inertEnvironment, object } from './policy.js';

const packageName = '@microsoft/vally-cli';
const registry = 'https://registry.npmjs.org';
const execute = promisify(execFile);
export interface EngineRelease { version: string; integrity: string }
export interface EngineIdentity extends EngineRelease {
  entry: string;
  sha256: string;
  dependencySha256: string;
  lockSha256: string;
}
export type FetchMetadata = (url: string) => Promise<unknown>;
export type InstallProcess = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<void>;

export function releaseMetadata(value: unknown, requested: string): EngineRelease {
  const metadata = object(value);
  const dist = object(metadata.dist);
  if (metadata.name !== packageName || typeof metadata.version !== 'string' || !exactVersion(metadata.version) ||
      (requested !== 'latest' && metadata.version !== requested) ||
      typeof dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity)) {
    throw new Error('Registry did not return the requested stable Vally version and SHA-512 integrity.');
  }
  return { version: metadata.version, integrity: dist.integrity };
}

async function fetchMetadata(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Vally registry resolution failed.');
  return response.json();
}

function isExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export async function resolveRelease(requested: string, jobDirectory: string, fetcher: FetchMetadata = fetchMetadata): Promise<EngineRelease> {
  if (requested !== 'latest' && !exactVersion(requested)) throw new Error('Invalid Vally version.');
  await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
  return withInstallationLock(jobDirectory, sha256(`resolution:${requested}`), () => resolveLockedRelease(requested, jobDirectory, fetcher));
}

async function resolveLockedRelease(requested: string, jobDirectory: string, fetcher: FetchMetadata): Promise<EngineRelease> {
  const snapshot = join(jobDirectory, `resolution-${requested}.json`);
  try {
    const saved: unknown = JSON.parse(await readFile(snapshot, 'utf8'));
    const entry = object(saved);
    return releaseMetadata({ name: packageName, version: entry.version, dist: { integrity: entry.integrity } }, requested);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const release = releaseMetadata(await fetcher(`${registry}/@microsoft%2fvally-cli/${requested}`), requested);
  const staged = join(jobDirectory, `resolution-${randomUUID()}.json`);
  await writeFile(staged, JSON.stringify(release), { flag: 'wx', mode: 0o600 });
  try {
    // A completed file is linked atomically: concurrent readers never observe partial JSON.
    await link(staged, snapshot);
  } finally {
    await unlink(staged);
  }
  return release;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function dependencyDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const root = await realpath(directory);
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name);
      const info = await lstat(file);
      hash.update(relative(root, file).split(sep).join('/')).update('\0');
      hash.update(String(info.mode & 0o777)).update('\0');
      if (info.isSymbolicLink()) {
        const target = await realpath(file);
        const rel = relative(root, target);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Tool dependency symlink escapes installation.');
        hash.update('link\0').update(await readlink(file));
      } else if (info.isDirectory()) {
        hash.update('directory\0');
        await visit(file);
      } else if (info.isFile()) {
        hash.update('file\0').update(await readFile(file));
      } else {
        throw new Error('Unsupported tool dependency file.');
      }
      hash.update('\0');
    }
  }
  await visit(root);
  return hash.digest('hex');
}

export async function inspectInstallation(directory: string, release: EngineRelease): Promise<EngineIdentity> {
  const lockSource = await readFile(join(directory, 'package-lock.json'), 'utf8');
  const lock = object(JSON.parse(lockSource));
  const packages = object(lock.packages);
  const installed = object(packages[`node_modules/${packageName}`]);
  if (installed.version !== release.version || installed.integrity !== release.integrity) throw new Error('Vally integrity or version mismatch.');
  for (const [path, value] of Object.entries(packages)) {
    if (!path) continue;
    const dependency = object(value);
    if (typeof dependency.resolved !== 'string' || !dependency.resolved.startsWith(`${registry}/`) ||
        typeof dependency.integrity !== 'string' || !/^sha(256|384|512)-[A-Za-z0-9+/]+=*$/.test(dependency.integrity)) {
      throw new Error('Non-registry or unverified dependency in Vally installation.');
    }
  }
  const packageDirectory = join(directory, 'node_modules', '@microsoft', 'vally-cli');
  const manifest = object(JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')));
  if (manifest.name !== packageName || manifest.version !== release.version || object(manifest.bin).vally !== 'dist/index.js') {
    throw new Error('Unsupported Vally package identity or executable layout.');
  }
  const entry = join(packageDirectory, 'dist', 'index.js');
  return {
    ...release, entry, sha256: sha256(await readFile(entry)),
    dependencySha256: await dependencyDigest(join(directory, 'node_modules')),
    lockSha256: sha256(lockSource),
  };
}

// The caller supplies a private job-scoped directory, never the project or a restored cross-job cache.
// Job-local receipts bind the concrete CLI and installed dependency graph.
export async function acquireEngine(
  release: EngineRelease, jobDirectory: string,
  install: InstallProcess = async (args, cwd, env) => {
    await execute('npm', args, { cwd, env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  },
): Promise<EngineIdentity> {
  releaseMetadata({ name: packageName, version: release.version, dist: { integrity: release.integrity } }, release.version);
  const identity = sha256(JSON.stringify([release, process.platform, process.arch, process.version]));
  await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
  return withInstallationLock(jobDirectory, identity, async () => {
    const receipt = join(jobDirectory, `${identity}.json`);
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(receipt, 'utf8'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (saved !== undefined) {
      const cached = object(saved);
      const recorded = object(cached.engine);
      if (typeof cached.directory !== 'string' || !cached.directory.startsWith(`${identity}-`) ||
          cached.directory.includes('/') || cached.directory.includes('\\') ||
          recorded.version !== release.version || recorded.integrity !== release.integrity ||
          typeof recorded.entry !== 'string' ||
          ![recorded.sha256, recorded.dependencySha256, recorded.lockSha256].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
        throw new Error('Invalid installed-tool receipt; cache reuse is refused.');
      }
      const directory = join(jobDirectory, cached.directory);
      const root = await realpath(jobDirectory);
      if (relative(root, await realpath(directory)) !== cached.directory) throw new Error('Cached installation escapes its job directory.');
      const expected: EngineIdentity = {
        ...release, entry: recorded.entry, sha256: String(recorded.sha256),
        dependencySha256: String(recorded.dependencySha256), lockSha256: String(recorded.lockSha256),
      };
      return verifyCachedEngine(directory, expected);
    }
    const installed = await installEngine(release, jobDirectory, identity, install);
    const engine = installed.engine;
    const directory = relative(await realpath(jobDirectory), await realpath(installed.directory));
    const staged = join(jobDirectory, `receipt-${randomUUID()}.json`);
    await writeFile(staged, JSON.stringify({ directory, engine }), { flag: 'wx', mode: 0o600 });
    try {
      await link(staged, receipt);
    } finally {
      await unlink(staged);
    }
    return engine;
  });
}

export async function withInstallationLock<T>(
  jobDirectory: string, key: string, operation: () => Promise<T>, waitMilliseconds = 330_000,
): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid tool lock key.');
  const lock = join(jobDirectory, `${key}.lock`);
  const deadline = Date.now() + waitMilliseconds;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isExists(error)) throw error;
      if (Date.now() >= deadline) throw new Error('Tool installation lock timed out; a stale lock is not reclaimed automatically.');
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
  try {
    return await operation();
  } finally {
    await rmdir(lock);
  }
}

async function installEngine(
  release: EngineRelease, jobDirectory: string, identity: string, install: InstallProcess,
): Promise<{ directory: string; engine: EngineIdentity }> {
  const directory = await mkdtemp(join(jobDirectory, `${identity}-`));
  const userConfig = join(directory, 'user.npmrc');
  const globalConfig = join(directory, 'global.npmrc');
  await Promise.all([
    writeFile(userConfig, '', { mode: 0o600 }),
    writeFile(globalConfig, '', { mode: 0o600 }),
    writeFile(join(directory, 'package.json'), JSON.stringify({
      name: 'evals-action-toolchain', private: true, dependencies: { [packageName]: release.version },
    }), { mode: 0o600 }),
  ]);
  const env = inertEnvironment(process.env);
  env.HOME = directory;
  await install([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress',
    '--registry', registry, '--userconfig', userConfig, '--globalconfig', globalConfig,
    '--cache', join(directory, 'cache'), '--prefix', directory,
  ], directory, env);
  return { directory, engine: await inspectInstallation(directory, release) };
}

export async function verifyCachedEngine(directory: string, expected: EngineIdentity): Promise<EngineIdentity> {
  const actual = await inspectInstallation(directory, expected);
  if (actual.entry !== expected.entry || actual.sha256 !== expected.sha256 ||
      actual.dependencySha256 !== expected.dependencySha256 || actual.lockSha256 !== expected.lockSha256) {
    throw new Error('Cached Vally dependency graph changed; do not reuse this installation.');
  }
  return actual;
}

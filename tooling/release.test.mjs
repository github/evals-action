import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isAncestor, nextVersion, parseVersion, planAutomatic, planRelease, recheckPlan } from './release.mjs';

test('isAncestor treats only git exit 1 as "not an ancestor" and rethrows git errors', () => {
  const exit = (status) => () => {
    throw Object.assign(new Error('git failed'), { status });
  };
  assert.equal(isAncestor('v0.2.0', 'HEAD', () => ''), true);
  assert.equal(isAncestor('v0.2.0', 'HEAD', exit(1)), false);
  assert.throws(() => isAncestor('v0.2.0', 'HEAD', exit(128)), /git failed/);
});

test('accepts only plain vMAJOR.MINOR.PATCH release tags', () => {
  assert.deepEqual(parseVersion('v0.3.0'), [0, 3, 0]);
  assert.deepEqual(parseVersion('v12.0.7'), [12, 0, 7]);
  for (const value of ['0.3.0', 'v0', 'v0.3', 'v0.3.0-rc.1', 'v01.2.3', ' v0.3.0', 'v0.3.0\n', 'v0.3.0;rm']) {
    assert.throws(() => parseVersion(value), /vMAJOR\.MINOR\.PATCH/, value);
  }
});

test('plans a new release and advances its major alias', () => {
  assert.deepEqual(planRelease({ version: 'v0.3.0', prerelease: true, tags: ['v0', 'v0.1.0', 'v0.2.0'], missingLicenseText: 3 }), {
    tag: 'v0.3.0', alias: 'v0', moveAlias: true, prerelease: true, latest: false,
  });
  assert.deepEqual(planRelease({ version: 'v1.0.0', prerelease: false, tags: ['v0', 'v0.9.0'], missingLicenseText: 0 }), {
    tag: 'v1.0.0', alias: 'v1', moveAlias: true, prerelease: false, latest: true,
  });
});

test('never overwrites a version tag', () => {
  assert.throws(() => planRelease({ version: 'v0.2.0', prerelease: true, tags: ['v0', 'v0.2.0'], missingLicenseText: 0 }), /already exists/);
});

test('keeps the alias on the newest release of its major line', () => {
  const plan = planRelease({ version: 'v0.2.1', prerelease: true, tags: ['v0', 'v0.2.0', 'v0.3.0', 'v1.0.0'], missingLicenseText: 0 });
  assert.equal(plan.alias, 'v0');
  assert.equal(plan.moveAlias, false);
  assert.equal(plan.latest, false);
  assert.equal(planRelease({ version: 'v0.4.0', prerelease: true, tags: ['v0.3.0', 'v1', 'v1.0.0'], missingLicenseText: 0 }).moveAlias, true);
  assert.deepEqual(planRelease({ version: 'v0.9.1', prerelease: false, tags: ['v0.9.0', 'v1.0.0'], missingLicenseText: 0 }),
    { tag: 'v0.9.1', alias: 'v0', moveAlias: true, prerelease: false, latest: false });
});

test('refuses stable releases while bundled license text is unresolved', () => {
  assert.throws(() => planRelease({ version: 'v1.0.0', prerelease: false, tags: [], missingLicenseText: 3 }), /missing-license-text/);
  assert.doesNotThrow(() => planRelease({ version: 'v0.3.0', prerelease: true, tags: [], missingLicenseText: 3 }));
});

test('rechecks retried publications against current tags', () => {
  const base = { version: 'v0.3.0', prerelease: false, missingLicenseText: 0, moveAlias: true, latest: true };
  assert.equal(recheckPlan({ ...base, tags: ['v0', 'v0.2.0', 'v0.3.0'] }).moveAlias, true);
  assert.throws(() => recheckPlan({ ...base, tags: ['v0', 'v0.2.0', 'v0.3.0', 'v0.4.0'] }), /stale/);
  assert.throws(() => recheckPlan({ ...base, tags: ['v0.2.0', 'v1.0.0'] }), /stale/);
});

test('bumps from the newest version tag', () => {
  const tags = ['v0', 'v0.1.0', 'v0.2.0', 'v0.10.1', 'v0.2.0-rc.1', 'other'];
  assert.equal(nextVersion(tags, 'patch'), 'v0.10.2');
  assert.equal(nextVersion(tags, 'minor'), 'v0.11.0');
  assert.equal(nextVersion(tags, 'major'), 'v1.0.0');
  assert.equal(nextVersion([], 'patch'), 'v0.0.1');
  assert.throws(() => nextVersion(tags, 'prerelease'), /patch, minor or major/);
});

test('automatically releases a patch only when shipped files changed', () => {
  const base = { tags: ['v0', 'v0.2.0'], latestIsAncestor: true, messages: ['fix: handle empty report'] };
  for (const file of ['src/main.ts', 'dist/index.js', 'action.yml']) {
    assert.deepEqual(planAutomatic({ ...base, changedFiles: ['README.md', file] }), { release: true, version: 'v0.2.1' });
  }
  const skipped = planAutomatic({ ...base, changedFiles: ['README.md', 'tests/a.test.ts', '.github/workflows/ci.yml', 'src.md'] });
  assert.equal(skipped.release, false);
  assert.match(skipped.reason, /no changes to src\/, dist\/ or action\.yml since v0\.2\.0/);
});

test('skips commits already covered by a newer release tag', () => {
  const plan = planAutomatic({ tags: ['v0.2.0'], latestIsAncestor: false, changedFiles: ['src/main.ts'], messages: [] });
  assert.equal(plan.release, false);
  assert.match(plan.reason, /not an ancestor/);
});

test('refuses to auto-release breaking changes as a patch', () => {
  const base = { tags: ['v0.2.0'], latestIsAncestor: true, changedFiles: ['src/main.ts'] };
  for (const message of ['feat!: drop input', 'FEAT!: drop input', 'Refactor(report)!: rename output', 'fix: x\n\nBREAKING CHANGE: removed y', 'fix: x\n\nBREAKING-CHANGE: removed y']) {
    assert.throws(() => planAutomatic({ ...base, messages: ['docs: ok', message] }), /manual minor or major release/, message);
  }
  assert.doesNotThrow(() => planAutomatic({ ...base, messages: ['fix: mention breaking change handling', 'feat: add! marker'] }));
});

test('plan releases a patch when a shipped file moves out of a shipped path', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'release-plan-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, 'src', 'index.js'), 'export const value = 1;\n');
  writeFileSync(join(repo, 'dist', 'bundled-dependencies.json'), '[]\n');
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'feat: initial');
  git('tag', 'v0.1.0');
  mkdirSync(join(repo, 'lib'));
  git('mv', 'src/index.js', 'lib/index.js');
  git('commit', '-q', '-m', 'refactor: move entry point');
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./release.mjs', import.meta.url)), 'plan', 'patch', 'false', 'true'], { cwd: repo, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
  assert.match(output, /^release=true$/m);
  assert.match(output, /^tag=v0\.1\.1$/m);
});
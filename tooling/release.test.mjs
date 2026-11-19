import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVersion, planRelease, recheckPlan } from './release.mjs';

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

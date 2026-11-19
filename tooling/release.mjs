#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(value) {
  const match = VERSION.exec(value);
  if (!match) throw new Error(`Release version must be vMAJOR.MINOR.PATCH, received ${JSON.stringify(value)}.`);
  return match.slice(1).map(Number);
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

export function planRelease({ version, prerelease, tags, missingLicenseText }) {
  const parsed = parseVersion(version);
  if (tags.includes(version)) throw new Error(`Tag ${version} already exists; published version tags are never moved.`);
  if (!prerelease && missingLicenseText > 0) {
    throw new Error(`${missingLicenseText} bundled dependencies are missing-license-text; resolve them before a stable release.`);
  }
  const versions = tags.filter((tag) => VERSION.test(tag)).map(parseVersion);
  const newest = (candidates) => candidates.every((existing) => compare(parsed, existing) > 0);
  const moveAlias = newest(versions.filter(([major]) => major === parsed[0]));
  return { tag: version, alias: `v${parsed[0]}`, moveAlias, prerelease, latest: !prerelease && newest(versions) };
}

// A retried publish job reuses verify outputs; reject them if newer tags appeared since verification.
export function recheckPlan({ version, prerelease, tags, missingLicenseText, moveAlias, latest }) {
  const plan = planRelease({ version, prerelease, tags: tags.filter((tag) => tag !== version), missingLicenseText });
  if (plan.moveAlias !== moveAlias || plan.latest !== latest) {
    throw new Error(`Release plan for ${version} is stale: version tags changed after verification. Dispatch a new release run.`);
  }
  return plan;
}

function flag(value, name) {
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false.`);
  return value === 'true';
}

function main() {
  const args = process.argv.slice(2);
  const recheck = args[0] === 'recheck';
  const [version, prerelease, moveAlias, latest] = recheck ? args.slice(1) : args;
  const tags = recheck
    ? (process.env.RELEASE_TAGS ?? '').split('\n').map((tag) => tag.trim()).filter(Boolean)
    : execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const inventory = JSON.parse(readFileSync('dist/bundled-dependencies.json', 'utf8'));
  const missingLicenseText = inventory.filter((item) => item.status === 'missing-license-text').length;
  const input = { version, prerelease: flag(prerelease, 'prerelease'), tags, missingLicenseText };
  const plan = recheck
    ? recheckPlan({ ...input, moveAlias: flag(moveAlias, 'move-alias'), latest: flag(latest, 'latest') })
    : planRelease(input);
  const output = Object.entries(plan).map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
  if (missingLicenseText > 0) process.stdout.write(`::warning::${missingLicenseText} bundled dependencies remain missing-license-text (prerelease only).\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

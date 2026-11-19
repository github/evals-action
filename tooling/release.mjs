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

function main() {
  const [version, prerelease] = process.argv.slice(2);
  if (prerelease !== 'true' && prerelease !== 'false') throw new Error('Usage: release.mjs <vMAJOR.MINOR.PATCH> <true|false>');
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const inventory = JSON.parse(readFileSync('dist/bundled-dependencies.json', 'utf8'));
  const missingLicenseText = inventory.filter((item) => item.status === 'missing-license-text').length;
  const plan = planRelease({ version, prerelease: prerelease === 'true', tags, missingLicenseText });
  const output = Object.entries(plan).map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
  if (missingLicenseText > 0) process.stdout.write(`::warning::${missingLicenseText} bundled dependencies remain missing-license-text (prerelease only).\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

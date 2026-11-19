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

export function nextVersion(tags, bump) {
  const [major, minor, patch] = tags.filter((tag) => VERSION.test(tag)).map(parseVersion).sort(compare).at(-1) ?? [0, 0, 0];
  if (bump === 'patch') return `v${major}.${minor}.${patch + 1}`;
  if (bump === 'minor') return `v${major}.${minor + 1}.0`;
  if (bump === 'major') return `v${major + 1}.0.0`;
  throw new Error(`Release bump must be patch, minor or major, received ${JSON.stringify(bump)}.`);
}

const SHIPPED = [/^src\//, /^dist\//, /^action\.yml$/];
const BREAKING_SUBJECT = /^[a-z]+(\([^)\n]*\))?!:/i;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

export function newestVersion(tags) {
  return tags.filter((tag) => VERSION.test(tag)).sort((left, right) => compare(parseVersion(left), parseVersion(right))).at(-1);
}

// Unattended releases ship a patch for shipped-file changes since the newest version tag.
export function planAutomatic({ tags, latestIsAncestor, changedFiles, messages }) {
  const latest = newestVersion(tags) ?? 'the first commit';
  if (!latestIsAncestor) return { release: false, reason: `${latest} is not an ancestor of this commit; a newer release already covers it.` };
  if (!changedFiles.some((file) => SHIPPED.some((pattern) => pattern.test(file)))) {
    return { release: false, reason: `no changes to src/, dist/ or action.yml since ${latest}.` };
  }
  if (messages.some((message) => BREAKING_SUBJECT.test(message) || BREAKING_FOOTER.test(message))) {
    throw new Error(`Commits since ${latest} declare a breaking change; dispatch a manual minor or major release instead of an automatic patch.`);
  }
  return { release: true, version: nextVersion(tags, 'patch') };
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

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function automaticInput(tags) {
  const latest = newestVersion(tags);
  if (!latest) return { tags, latestIsAncestor: true, changedFiles: git('ls-files').split('\n').filter(Boolean), messages: [] };
  let latestIsAncestor = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', latest, 'HEAD']);
  } catch {
    latestIsAncestor = false;
  }
  return {
    tags,
    latestIsAncestor,
    changedFiles: git('diff', '--name-only', '--no-renames', latest, 'HEAD').split('\n').filter(Boolean),
    messages: git('log', '--format=%B%x00', `${latest}..HEAD`).split('\0').map((message) => message.trim()).filter(Boolean),
  };
}

function emit(values) {
  const output = Object.entries(values).map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'plan' && command !== 'recheck') throw new Error('Usage: release.mjs plan <bump> <prerelease> <automatic> | recheck <version> <prerelease> <move-alias> <latest>');
  const inventory = JSON.parse(readFileSync('dist/bundled-dependencies.json', 'utf8'));
  const missingLicenseText = inventory.filter((item) => item.status === 'missing-license-text').length;
  if (command === 'recheck') {
    const [version, prerelease, moveAlias, latest] = args;
    const tags = (process.env.RELEASE_TAGS ?? '').split('\n').map((tag) => tag.trim()).filter(Boolean);
    emit(recheckPlan({ version, prerelease: flag(prerelease, 'prerelease'), tags, missingLicenseText, moveAlias: flag(moveAlias, 'move-alias'), latest: flag(latest, 'latest') }));
    return;
  }
  const [bump, prerelease, automatic] = args;
  const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
  let version = nextVersion(tags, bump);
  if (flag(automatic, 'automatic')) {
    if (bump !== 'patch') throw new Error('Automatic releases are patch releases only.');
    const decision = planAutomatic(automaticInput(tags));
    if (!decision.release) {
      process.stdout.write(`::notice::Skipping automatic release: ${decision.reason}\n`);
      emit({ release: false });
      return;
    }
    version = decision.version;
  }
  emit({ release: true, ...planRelease({ version, prerelease: flag(prerelease, 'prerelease'), tags, missingLicenseText }) });
  if (missingLicenseText > 0) process.stdout.write(`::warning::${missingLicenseText} bundled dependencies remain missing-license-text (prerelease only).\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { bundledLicenseNotices } from './license-notices.mjs';
import { parse, parseAllDocuments } from 'yaml';

test('bundled notices are deterministic, preserve full terms, and expose missing terms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evals-licenses-'));
  try {
    const fixtures = [
      { name: '@fixture/z', version: '1.0.0', license: 'MIT', files: { LICENSE: 'Synthetic full terms \t\r\n', NOTICE: 'Synthetic attribution\r\n' } },
      { name: '@fixture/a', version: '1.0.0', license: 'MIT', files: { NOTICE: 'README fixture attribution.', 'README.md': '# Usage\nExample\n\n## License\nCopyright fixture\nPermission is hereby granted\nTHE SOFTWARE IS PROVIDED AS IS\n### Attribution\nPreserve this attribution.\n## Contributing\nNot part of the license section.\n' } },
      { name: '@fixture/missing', version: '1.0.0', license: 'MIT', files: { NOTICE: 'Attribution without license terms.', 'README.md': '# Fixture\nNo license terms.' } },
      { name: '@nodable/entities', version: '3.1.0', license: 'MIT', files: { NOTICE: 'Supplement fixture attribution.' } },
    ];
    const inputs = [];
    for (const { files, ...manifest } of fixtures) {
      const directory = join(root, 'node_modules', ...manifest.name.split('/'));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
      for (const [file, text] of Object.entries(files)) await writeFile(join(directory, file), text);
      inputs.push(join(directory, 'index.js'), join(directory, 'other.js'));
    }
    inputs.push(join(root, 'src', 'index.js'));
    const contributions = Object.fromEntries(inputs.map(input => [input, { bytesInOutput: 1 }]));
    contributions[join(root, 'node_modules', 'not-distributed', 'index.js')] = { bytesInOutput: 0 };
    const result = await bundledLicenseNotices(contributions);
    assert.deepEqual(result, await bundledLicenseNotices(Object.fromEntries(Object.entries(contributions).toReversed())));
    assert.deepEqual(result.inventory.map(item => item.name), ['@fixture/a', '@fixture/missing', '@fixture/z', '@nodable/entities']);
    assert.deepEqual(result.inventory[1], {
      name: '@fixture/missing', version: '1.0.0', declaredLicense: 'MIT',
      status: 'missing-license-text', sources: ['NOTICE'],
    });
    assert.equal(result.inventory[0].status, 'license-text-included');
    assert.deepEqual(result.inventory[0].sources, ['NOTICE', 'README.md (license section)']);
    assert.equal(result.inventory[3].status, 'license-text-included');
    assert.deepEqual(result.inventory[3].sources, [
      'NOTICE',
      'https://github.com/nodable/val-parsers/blob/ac48e7ea591da372be023a481875c747535812b3/LICENSE',
    ]);
    assert.match(result.text, /Synthetic full terms/);
    assert.match(result.text, /Synthetic attribution/);
    assert.match(result.text, /README fixture attribution/);
    assert.match(result.text, /Supplement fixture attribution/);
    assert.match(result.text, /Attribution without license terms/);
    assert.equal(result.text.match(/No full license text was supplied/g)?.length, 1);
    assert.match(result.text, /Copyright fixture\nPermission is hereby granted\nTHE SOFTWARE IS PROVIDED AS IS/);
    assert.match(result.text, /Preserve this attribution\./);
    assert.doesNotMatch(result.text, /Not part of the license section/);
    assert.doesNotMatch(result.text, /\r/);
    assert.doesNotMatch(result.text, /[ \t]+$/m);
    assert.ok(!result.text.includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packaged Action includes the full license notice for its bundled YAML dependency', async () => {
  const notices = await readFile(resolve('dist/THIRD-PARTY-NOTICES.txt'), 'utf8');
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve('yaml/package.json'));
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const license = (await readFile(join(directory, 'LICENSE'), 'utf8')).replaceAll('\r\n', '\n').trim();
  assert.ok(notices.includes(`Package: ${manifest.name}\nVersion: ${manifest.version}\nLicense: ${manifest.license}`));
  assert.ok(notices.includes(license));
  assert.ok(!notices.includes(resolve('node_modules')));
});

test('packaged protobuf runtime includes its Apache and both BSD source notices', async () => {
  const notices = await readFile(resolve('dist/THIRD-PARTY-NOTICES.txt'), 'utf8');
  const artifactRequire = createRequire(new URL(import.meta.resolve('@actions/artifact')));
  const directory = dirname(artifactRequire.resolve('@protobuf-ts/runtime/package.json'));
  const start = notices.indexOf('Package: @protobuf-ts/runtime\n');
  assert.ok(start >= 0);
  const end = notices.indexOf('='.repeat(72), start);
  const section = notices.slice(start, end < 0 ? undefined : end);
  assert.ok(section.includes((await readFile(join(directory, 'LICENSE'), 'utf8')).trim()));
  for (const file of ['goog-varint.js', 'protobufjs-utf8.js']) {
    const lines = (await readFile(join(directory, 'build', 'commonjs', file), 'utf8')).split('\n');
    const firstDefinition = lines.findIndex(line => line.startsWith('Object.defineProperty'));
    assert.ok(firstDefinition > 1);
    const license = lines.slice(1, firstDefinition).map(line => line.replace(/^\/\/ ?/, '')).join('\n').trim();
    assert.ok(section.includes(license), file);
  }
  const root = await mkdtemp(join(tmpdir(), 'evals-protobuf-licenses-'));
  try {
    const fixture = join(root, 'node_modules', '@protobuf-ts', 'runtime');
    await mkdir(join(fixture, 'build', 'commonjs'), { recursive: true });
    await writeFile(join(fixture, 'package.json'), JSON.stringify({
      name: '@protobuf-ts/runtime', version: '2.11.1', license: '(Apache-2.0 AND BSD-3-Clause)',
    }));
    for (const file of ['goog-varint.js', 'protobufjs-utf8.js']) {
      await copyFile(join(directory, 'build', 'commonjs', file), join(fixture, 'build', 'commonjs', file));
    }
    await assert.rejects(bundledLicenseNotices({
      [join(fixture, 'build', 'commonjs', 'goog-varint.js')]: { bytesInOutput: 1 },
    }), /Missing package license/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dependency inventory excludes code removed completely by tree shaking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evals-tree-shaking-'));
  try {
    const modules = [
      { name: 'fixture-live', code: 'export function kept() { return 42; }\n' },
      { name: 'fixture-dead', code: 'export function removed() { return 99; }\n' },
      { name: 'fixture-relay', code: 'export { kept } from "fixture-live"; export { removed } from "fixture-dead";\n' },
    ];
    for (const { name, code } of modules) {
      const directory = join(root, 'node_modules', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name, version: '1.0.0', type: 'module', main: 'index.js', sideEffects: false,
      }));
      await writeFile(join(directory, 'index.js'), code);
    }
    const entry = join(root, 'entry.mjs');
    await writeFile(entry, 'import { kept } from "fixture-relay"; console.log(kept());\n');
    const result = await build({
      entryPoints: [entry], outfile: join(root, 'bundle.cjs'),
      bundle: true, platform: 'node', format: 'cjs', metafile: true, write: false,
    });
    assert.ok(Object.keys(result.metafile.inputs)
      .some(file => file.replaceAll('\\', '/').endsWith('/node_modules/fixture-dead/index.js')));
    const notices = await bundledLicenseNotices(Object.values(result.metafile.outputs)[0].inputs);
    assert.deepEqual(notices.inventory.map(item => item.name), ['fixture-live']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packaged dependency inventory preserves the three unresolved upstream license gaps', async () => {
  const inventory = JSON.parse(await readFile(resolve('dist/bundled-dependencies.json'), 'utf8'));
  assert.deepEqual(inventory.filter(item => item.status === 'missing-license-text')
    .map(item => `${item.name}@${item.version}`), ['binary@0.3.0', 'buffers@0.1.1', 'chainsaw@0.1.0']);
  assert.equal(inventory.find(item => item.name === 'buffers').declaredLicense, null);
  assert.deepEqual(inventory.find(item => item.name === '@nodable/entities').sources, [
    'https://github.com/nodable/val-parsers/blob/ac48e7ea591da372be023a481875c747535812b3/LICENSE',
  ]);
});

test('frozen installs do not depend on registry-specific mirror tarball overrides', async () => {
  const documents = parseAllDocuments(await readFile(resolve('pnpm-lock.yaml'), 'utf8'));
  for (const document of documents) {
    assert.deepEqual(document.errors, []);
    for (const entry of Object.values(document.toJS().packages ?? {})) {
      const tarball = entry.resolution?.tarball;
      if (tarball !== undefined) {
        const url = new URL(tarball);
        assert.equal(url.protocol, 'https:');
        assert.equal(url.hostname, 'registry.npmjs.org');
      }
    }
  }
});

test('packaged Action rejects missing project configuration from a clean consumer directory without dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evals-packaged-'));
  try {
    const entry = join(root, 'index.cjs');
    await copyFile(resolve('dist/index.cjs'), entry);
    const summary = join(root, 'summary.md');
    const output = join(root, 'output.txt');
    await Promise.all([writeFile(summary, ''), writeFile(output, ''), mkdir(join(root, 'runner'))]);
    const child = spawnSync(process.execPath, [entry], {
      cwd: root,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, RUNNER_TEMP: join(root, 'runner'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stdout, /invalid-input-or-context/);
    assert.match(await readFile(summary, 'utf8'), /Evals: error/);
    assert.match(await readFile(output, 'utf8'), /outcome/);
    // Artifact service credentials are intentionally absent; this is a fail-closed packaging control.
    assert.match(child.stdout, /Required structured reporting failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('comparison subaction resolves its own self-contained bundle and rejects missing command without leaking errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evals-comparison-packaged-'));
  try {
    const metadata = parse(await readFile(resolve('comparison/action.yml'), 'utf8'));
    assert.equal(metadata.runs.using, 'node24');
    const source = resolve('comparison', metadata.runs.main);
    assert.equal(source, resolve('dist/comparison-index.cjs'));
    const entry = join(root, 'comparison.cjs');
    await copyFile(source, entry);
    const child = spawnSync(process.execPath, [entry], {
      cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stdout, /comparison-invalid-command/);
    assert.match(child.stdout, /No evaluation pass is claimed/);
    assert.doesNotMatch(child.stdout, /node_modules|Error:|stack/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

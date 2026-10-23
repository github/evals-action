import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { bundledLicenseNotices } from './license-notices.mjs';

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
    const result = await bundledLicenseNotices(inputs);
    assert.deepEqual(result, await bundledLicenseNotices(inputs.toReversed()));
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

test('packaged dependency inventory preserves the three unresolved upstream license gaps', async () => {
  const inventory = JSON.parse(await readFile(resolve('dist/bundled-dependencies.json'), 'utf8'));
  assert.deepEqual(inventory.filter(item => item.status === 'missing-license-text')
    .map(item => `${item.name}@${item.version}`), ['binary@0.3.0', 'buffers@0.1.1', 'chainsaw@0.1.0']);
  assert.equal(inventory.find(item => item.name === 'buffers').declaredLicense, null);
  assert.deepEqual(inventory.find(item => item.name === '@nodable/entities').sources, [
    'https://github.com/nodable/val-parsers/blob/ac48e7ea591da372be023a481875c747535812b3/LICENSE',
  ]);
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

import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundledLicenseNotices } from './license-notices.mjs';

const result = await build({
  entryPoints: ['src/index.ts', 'src/comparison-index.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  supported: { 'template-literal': false },
  format: 'cjs',
  legalComments: 'external',
  sourcemap: false,
  write: false,
  minify: true,
  metafile: true,
});
const contributions = {};
for (const output of Object.values(result.metafile.outputs)) {
  for (const [file, contribution] of Object.entries(output.inputs)) {
    contributions[file] = { bytesInOutput: (contributions[file]?.bytesInOutput ?? 0) + contribution.bytesInOutput };
  }
}
const notices = await bundledLicenseNotices(contributions);
const outputs = [
  ...result.outputFiles,
  { path: resolve('dist/THIRD-PARTY-NOTICES.txt'), contents: Buffer.from(notices.text) },
  { path: resolve('dist/bundled-dependencies.json'), contents: Buffer.from(JSON.stringify(notices.inventory, null, 2) + '\n') },
];
for (const output of outputs) {
  if (process.argv.includes('--check')) {
    if (!Buffer.from(output.contents).equals(await readFile(output.path))) throw new Error('Packaged dist is stale. Run pnpm build.');
  } else {
    await mkdir('dist', { recursive: true });
    await writeFile(output.path, output.contents);
  }
}

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const supplementalNotices = {
  '@nodable/entities@3.1.0': {
    file: new URL('./licenses/nodable-entities-3.1.0.txt', import.meta.url),
    source: 'https://github.com/nodable/val-parsers/blob/ac48e7ea591da372be023a481875c747535812b3/LICENSE',
  },
};
const moduleLicenseHeaders = {
  '@protobuf-ts/runtime@2.11.1': [
    'build/commonjs/goog-varint.js',
    'build/commonjs/protobufjs-utf8.js',
  ],
};
const noticeName = /^(?:licen[cs]e|notice|copying|copyright|third[-_ ]?party[-_ ]?(?:notices?|licenses?))(?:[.-].*)?$/i;
const licenseName = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;
const normalize = text => text.replaceAll('\r\n', '\n').replace(/[ \t]+$/gm, '').trim();

export async function bundledLicenseNotices(inputContributions) {
  const directories = new Set();
  for (const [input, contribution] of Object.entries(inputContributions)) {
    if (!(contribution.bytesInOutput > 0)) continue;
    const parts = resolve(input).split(sep);
    const index = parts.lastIndexOf('node_modules');
    if (index < 0) continue;
    directories.add(parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join(sep));
  }

  const packages = new Map();
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error('Bundled dependency is missing its package identity.');
    }
    const id = `${manifest.name}@${manifest.version}`;
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => entry.name).sort();
    const notices = [];
    let hasLicenseText = false;
    for (const file of files.filter(file => noticeName.test(file))) {
      const text = normalize(await readFile(join(directory, file), 'utf8'));
      if (text) {
        notices.push({ source: file, text });
        hasLicenseText ||= licenseName.test(file);
      }
    }
    if (!hasLicenseText) {
      for (const file of files.filter(file => /^readme(?:[.-].*)?$/i.test(file))) {
        const text = normalize(await readFile(join(directory, file), 'utf8'));
        const heading = /^(#{1,6})\s+licen[cs]e[^\n]*\n/im.exec(text);
        const remainder = heading ? text.slice(heading.index + heading[0].length) : '';
        const nextHeading = heading ? new RegExp(`^#{1,${heading[1].length}}\\s`, 'm').exec(remainder) : null;
        const section = remainder.slice(0, nextHeading?.index ?? remainder.length);
        if (section?.includes('Permission is hereby granted') && section.includes('THE SOFTWARE IS PROVIDED')) {
          notices.push({ source: `${file} (license section)`, text: normalize(section) });
          hasLicenseText = true;
        }
      }
    }
    const supplement = supplementalNotices[id];
    if (!hasLicenseText && supplement) {
      const text = normalize(await readFile(supplement.file, 'utf8'));
      if (text) {
        notices.push({ source: supplement.source, text });
        hasLicenseText = true;
      }
    }
    const requiredHeaders = moduleLicenseHeaders[id] ?? [];
    if (requiredHeaders.length && !hasLicenseText) throw new Error(`Missing package license for ${id}.`);
    for (const file of requiredHeaders) {
      const source = (await readFile(join(directory, file), 'utf8')).replaceAll('\r\n', '\n');
      const header = /^(?:"use strict";\n)?((?:\/\/[^\n]*\n)+)/.exec(source)?.[1];
      if (!header?.includes('Redistribution and use in source and binary forms') ||
          !header.includes('THIS SOFTWARE IS PROVIDED')) {
        throw new Error(`Missing pinned module license header: ${id}/${file}.`);
      }
      notices.push({
        source: `${file} (license header)`,
        text: normalize(header.split('\n').map(line => line.replace(/^\/\/ ?/, '')).join('\n')),
      });
    }
    const entry = {
      name: manifest.name,
      version: manifest.version,
      declaredLicense: typeof manifest.license === 'string' ? manifest.license : null,
      status: hasLicenseText ? 'license-text-included' : 'missing-license-text',
      sources: notices.map(notice => notice.source),
    };
    const text = [
      `Package: ${entry.name}`, `Version: ${entry.version}`,
      `License: ${entry.declaredLicense ?? 'NOT DECLARED'}`,
      `Notice status: ${entry.status}`, '',
      ...notices.map(notice => `Source: ${notice.source}\n\n${notice.text}`),
      ...(!hasLicenseText ? ['No full license text was supplied by the installed package. Release-owner clearance is required; no permission is inferred.'] : []),
    ].join('\n');
    const previous = packages.get(id);
    if (previous && previous.text !== text) throw new Error(`Conflicting bundled notices for ${id}.`);
    packages.set(id, { entry, text });
  }
  const ordered = [...packages.keys()].sort().map(id => packages.get(id));
  return {
    inventory: ordered.map(item => item.entry),
    text: [
      'THIRD-PARTY NOTICES', 'GitHub Evals Action', '',
      'This inventory describes packages contributing code to dist/index.cjs and dist/comparison-index.cjs.',
      'License text inclusion is evidence, not release approval. Missing terms remain unresolved.',
      'Inline third-party comments are retained separately in index.cjs.LEGAL.txt and comparison-index.cjs.LEGAL.txt.', '',
      ...ordered.map(item => `${'='.repeat(72)}\n${item.text}\n`),
    ].join('\n'),
  };
}

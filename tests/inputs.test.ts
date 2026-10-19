import { describe, expect, it } from 'vitest';
import { DEFAULT_VALLY_VERSION, parseInputs } from '../src/inputs.js';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const base: Record<string, string> = { command: 'plan', 'working-directory': '.', suite: 'regression' };
const parseValues = (values: Record<string, string> = {}) => parseInputs((key) => ({ ...base, ...values })[key] ?? '');

describe('public inputs', () => {
  it('defaults to all while requiring explicit project and selection', () => {
    expect(parseValues({ command: '' }).command).toBe('all');
    expect(() => parseValues({ command: '', suite: '' })).toThrow(/selection/);
    expect(() => parseValues({ suite: '' })).toThrow(/selection/);
    expect(() => parseValues({ 'working-directory': '' })).toThrow(/required/);
  });
  it('allows selector-free lint but still requires explicit selection for run', () => {
    expect(parseValues({ command: 'lint', suite: '' })).toMatchObject({ command: 'lint', evalPaths: [], tags: [] });
    expect(() => parseValues({ command: 'run', suite: '' })).toThrow(/selection/);
  });
  it.each(['all', 'lint', 'plan', 'run', 'report'])('accepts explicit %s routing', (command) => {
    if (command === 'report') {
      expect(parseValues({
        command, 'working-directory': '', 'source-artifact-id': '123',
        'source-artifact-digest': 'a'.repeat(64),
      }).command).toBe(command);
      return;
    }
    expect(parseValues({ command }).command).toBe(command);
  });
  it.each(['RUN', 'bash', 'lint;echo secret', 'run --all'])('rejects command %s', (command) => {
    expect(() => parseValues({ command })).toThrow(/command/);
  });
  it('reserves enough report-id space for companion lint evidence', () => {
    expect(() => parseValues({ command: 'all', 'report-id': 'a'.repeat(60) })).toThrow(/prefix/);
  });
  it('preserves spaces, native selectors and omitted settings', () => {
    const inputs = parseValues({ suite: '', 'eval-paths': 'evals/path with spaces.eval.yaml\nother/**/*.yaml', tags: 'smoke\nrelease' });
    expect(inputs.evalPaths).toEqual(['evals/path with spaces.eval.yaml', 'other/**/*.yaml']);
    expect(inputs.tags).toEqual(['smoke', 'release']);
    expect(inputs.overrides).toEqual({});
    expect(inputs.vallyVersion).toBe(DEFAULT_VALLY_VERSION);
    expect(inputs.vallyVersion).toBe('latest');
    expect(parseValues({ 'vally-version': '0.20.0' }).vallyVersion).toBe('0.20.0');
  });
  it('keeps explicit native overrides distinct from absence', () => {
    expect(parseValues({ model: 'native/model', runs: '2', workers: '3', timeout: '60', 'max-retries': '0' }).overrides)
      .toEqual({ model: 'native/model', runs: 2, workers: 3, timeout: 60, maxRetries: 0 });
    expect(parseValues({ 'upload-transcripts': 'true', 'vally-version': '0.19.0' }))
      .toMatchObject({ uploadTranscripts: true, vallyVersion: '0.19.0' });
  });
  it('requires report inputs without requiring execution inputs', () => {
    expect(parseValues({
      command: 'report', 'working-directory': '', suite: '',
      'source-artifact-id': '123', 'source-artifact-digest': 'a'.repeat(64),
    })).toMatchObject({
      command: 'report', workingDirectory: '', sourceArtifactId: 123,
      sourceArtifactDigest: 'a'.repeat(64),
    });
    expect(() => parseValues({ command: 'report', 'working-directory': '', suite: '' })).toThrow(/source-artifact/);
    expect(() => parseValues({
      command: 'report', 'working-directory': '', suite: '',
      'source-artifact-id': '0', 'source-artifact-digest': 'a'.repeat(64),
    })).toThrow(/source-artifact-id/);
    expect(() => parseValues({
      command: 'report', 'working-directory': '', suite: '',
      'source-artifact-id': '123', 'source-artifact-digest': 'invalid',
    })).toThrow(/source-artifact-digest/);
    expect(() => parseValues({
      command: 'run', 'source-artifact-id': '123',
      'source-artifact-digest': 'a'.repeat(64),
    })).toThrow(/only valid for report/);
    expect(parseValues({
      command: 'report', 'working-directory': '', suite: '', 'report-id': 'evals-run',
      'source-artifact-id': '123', 'source-artifact-digest': 'a'.repeat(64),
      'lint-artifact-id': '124', 'lint-artifact-digest': 'b'.repeat(64),
    })).toMatchObject({ lintArtifactId: 124, lintArtifactDigest: 'b'.repeat(64) });
    for (const extra of [
      { 'lint-artifact-id': '124' },
      { 'lint-artifact-digest': 'b'.repeat(64) },
      { 'lint-artifact-id': '123', 'lint-artifact-digest': 'b'.repeat(64) },
    ]) expect(() => parseValues({
      command: 'report', 'working-directory': '', suite: '', 'report-id': 'evals-run',
      'source-artifact-id': '123', 'source-artifact-digest': 'a'.repeat(64), ...extra,
    })).toThrow();
  });
  it('preserves leading and trailing path spaces rather than selecting different files', () => {
    const inputs = parseValues({
      'working-directory': ' project directory ',
      'eval-paths': '\n leading.eval.yaml\r\ntrailing.eval.yaml \n spaced path \n',
    });
    expect(inputs.workingDirectory).toBe(' project directory ');
    expect(inputs.evalPaths).toEqual([' leading.eval.yaml', 'trailing.eval.yaml ', ' spaced path ']);
  });
  it.each([
    { runs: '0' }, { workers: '-1' }, { timeout: '1.2' }, { runs: '9007199254740992' }, { runs: '01' },
    { 'max-retries': '-1' }, { 'upload-transcripts': '1' },
    { 'vally-version': '^0.19.0' }, { 'vally-version': '0.19.0-beta.1' }, { 'vally-version': 'file:/tmp/x' },
    { 'artifact-retention-days': '91' }, { 'artifact-retention-days': '0' },
    { 'report-id': '../unsafe' }, { suite: 'bad\0name' },
  ])('rejects malformed values %j', (values) => expect(() => parseValues(values)).toThrow());
  it('keeps the metadata input contract in sync with the parser', async () => {
    const action = parse(await readFile('action.yml', 'utf8')) as {
      inputs: Record<string, { default?: unknown }>;
      runs: { using: string; main: string };
    };
    const read = new Set<string>();
    parseInputs((key) => { read.add(key); return base[key] ?? ''; });
    // The reporting secret is consumed separately and never retained in the parsed input DTO.
    expect([...read].sort()).toEqual(Object.keys(action.inputs).filter((key) => !['report-token', 'copilot-token', 'github-token'].includes(key)).sort());
    expect(action.inputs.command?.default).toBe('all');
    expect(action.inputs['github-token']?.default).toBe('${{ github.token }}');
    expect(action.inputs['vally-version']?.default).toBe(DEFAULT_VALLY_VERSION);
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/index.cjs' });
  });
});

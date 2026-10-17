import { describe, expect, it } from 'vitest';
import { parseInputs } from '../src/inputs.js';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const base: Record<string, string> = { command: 'plan', 'working-directory': '.', suite: 'regression' };
const parseValues = (values: Record<string, string> = {}) => parseInputs((key) => ({ ...base, ...values })[key] ?? '');

describe('public inputs', () => {
  it('never chooses a command or selection implicitly', () => {
    expect(() => parseValues({ command: '' })).toThrow(/required/);
    expect(() => parseValues({ suite: '' })).toThrow(/selection/);
    expect(() => parseValues({ 'working-directory': '' })).toThrow(/required/);
  });
  it('allows selector-free lint but still requires explicit selection for run', () => {
    expect(parseValues({ command: 'lint', suite: '' })).toMatchObject({ command: 'lint', evalPaths: [], tags: [] });
    expect(() => parseValues({ command: 'run', suite: '' })).toThrow(/selection/);
  });
  it.each(['lint', 'plan', 'run'])('accepts only explicit %s routing', (command) => {
    expect(parseValues({ command }).command).toBe(command);
  });
  it.each(['RUN', 'bash', 'lint;echo secret', 'run --all'])('rejects command %s', (command) => {
    expect(() => parseValues({ command })).toThrow(/command/);
  });
  it('preserves spaces, native selectors and omitted settings', () => {
    const inputs = parseValues({ suite: '', 'eval-paths': 'evals/path with spaces.eval.yaml\nother/**/*.yaml', tags: 'smoke\nrelease' });
    expect(inputs.evalPaths).toEqual(['evals/path with spaces.eval.yaml', 'other/**/*.yaml']);
    expect(inputs.tags).toEqual(['smoke', 'release']);
    expect(inputs.overrides).toEqual({});
    expect(inputs.vallyVersion).toBe('latest');
  });
  it('keeps explicit native overrides distinct from absence', () => {
    expect(parseValues({ model: 'native/model', runs: '2', workers: '3', timeout: '60', 'max-retries': '0' }).overrides)
      .toEqual({ model: 'native/model', runs: 2, workers: 3, timeout: 60, maxRetries: 0 });
    expect(parseValues({ comment: 'true', 'upload-transcripts': 'true', 'vally-version': '0.19.0' }))
      .toMatchObject({ comment: true, uploadTranscripts: true, vallyVersion: '0.19.0' });
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
    { 'max-retries': '-1' }, { comment: 'yes' }, { 'upload-transcripts': '1' },
    { 'vally-version': '^0.19.0' }, { 'vally-version': '0.19.0-beta.1' }, { 'vally-version': 'file:/tmp/x' },
    { 'artifact-retention-days': '91' }, { 'artifact-retention-days': '0' },
    { 'report-id': '../unsafe' }, { suite: 'bad\0name' },
  ])('rejects malformed values %j', (values) => expect(() => parseValues(values)).toThrow());
  it('keeps the metadata input contract in sync with the parser', async () => {
    const action = parse(await readFile('action.yml', 'utf8')) as { inputs: Record<string, unknown>; runs: { using: string; main: string } };
    const read = new Set<string>();
    parseInputs((key) => { read.add(key); return base[key] ?? ''; });
    // The reporting secret is consumed separately and never retained in the parsed input DTO.
    expect([...read].sort()).toEqual(Object.keys(action.inputs).filter((key) => key !== 'report-token').sort());
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/index.cjs' });
  });
});

export type Command = 'lint' | 'plan' | 'run';
export type InputReader = (name: string) => string;
export interface Inputs {
  command: Command;
  workingDirectory: string;
  suite?: string;
  evalPaths: string[];
  tags: string[];
  vallyVersion: string;
  overrides: { model?: string; runs?: number; workers?: number; timeout?: number; maxRetries?: number };
  comment: boolean;
  reportId: string;
  uploadTranscripts: boolean;
  retentionDays: number;
  credentialEnv: string[];
}

export function exactVersion(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

export function parseInputs(read: InputReader): Inputs {
  const raw = (name: string) => {
    const value = read(name);
    // eslint-disable-next-line no-control-regex -- Reject embedded control characters at the input boundary.
    if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`Invalid control character in ${name}.`);
    return value;
  };
  const text = (name: string) => raw(name).trim();
  const required = (name: string) => {
    const value = text(name);
    if (!value) throw new Error(`Input ${name} is required.`);
    return value;
  };
  const integer = (name: string, minimum: number): number | undefined => {
    const value = text(name);
    if (!value) return undefined;
    const number = Number(value);
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
      throw new Error(`Input ${name} must be an integer >= ${minimum}.`);
    }
    return number;
  };
  const boolean = (name: string) => {
    const value = text(name) || 'false';
    if (value !== 'true' && value !== 'false') throw new Error(`Input ${name} must be true or false.`);
    return value === 'true';
  };
  const lines = (name: string) => text(name).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const command = required('command');
  if (command !== 'lint' && command !== 'plan' && command !== 'run') throw new Error('Invalid command; use lint, plan, or run.');
  const workingDirectory = raw('working-directory');
  if (!workingDirectory) throw new Error('Input working-directory is required.');
  const suite = text('suite');
  const evalPaths = raw('eval-paths').split(/\r?\n/).filter((line) => line !== '');
  const tags = lines('tags');
  if (!suite && !evalPaths.length && !tags.length) throw new Error('Explicit suite, eval-paths, or tags selection is required.');
  const vallyVersion = text('vally-version') || 'latest';
  if (vallyVersion !== 'latest' && !exactVersion(vallyVersion)) throw new Error('vally-version must be latest or an exact stable version.');
  const reportId = text('report-id') || 'evals';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(reportId)) throw new Error('report-id must be 1-64 letters, digits, underscores or hyphens.');
  const retentionDays = integer('artifact-retention-days', 1) ?? 7;
  if (retentionDays > 90) throw new Error('artifact-retention-days must not exceed 90.');
  const overrides: Inputs['overrides'] = {};
  const model = text('model');
  if (model) overrides.model = model;
  for (const [input, key, minimum] of [
    ['runs', 'runs', 1], ['workers', 'workers', 1], ['timeout', 'timeout', 1], ['max-retries', 'maxRetries', 0],
  ] as const) {
    const value = integer(input, minimum);
    if (value !== undefined) overrides[key] = value;
  }
  return {
    command, workingDirectory, ...(suite ? { suite } : {}), evalPaths, tags, vallyVersion, overrides,
    comment: boolean('comment'), reportId, uploadTranscripts: boolean('upload-transcripts'), retentionDays,
    credentialEnv: lines('credential-env'),
  };
}

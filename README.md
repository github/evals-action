# Evals Action

Acquire Vally and invoke its native CLI from GitHub Actions. The Action handles
installation, GitHub reporting and artifacts; **Vally owns selection, execution
and grading**. No separate Runtime/Core package is required.

Initial supported host: **Linux x64 GitHub-hosted runners, Node 24**. This is
development code, not a published Marketplace release. Repository access is
required while the repository is private. Pin a reviewed full commit SHA.

## Commands

| Action command | Native command | Supported selection |
| --- | --- | --- |
| `lint` | `vally lint --eval-spec=<path>` for each supplied path | Explicit eval files or directories. No suite, tags or execution overrides. |
| `run` | `vally eval --require-pass --output=jsonl ...` | A named suite, explicit eval files, or native tags. |
| `plan` | None | Explicit error: Vally 0.19.0 exposes no plan/dry-run CLI. It never falls back to a run. |

`run` passes native options as argument-array values, never interpolated shell
commands. It does not parse `.vally.yaml`, expand shell globs, install custom
project packages, or introduce a second evaluation runner. `--suite` cannot
combine with paths or tags. Paths and tags can combine using Vally's semantics.
Put native file patterns in a named suite rather than `eval-paths`.

The adapter has model-free native qualification against Vally **0.19.0**,
including actual lint, suites, repetitions, multiple mock models, weighted
threshold pass, failed verdict, skipped selection and missing-suite controls.
Future CLI/evidence changes can fail explicitly; latest selection is not a
promise of compatibility with every future Vally version.

## Workflow example

Replace `<reviewed-full-commit-sha>` with an actual reviewed Action commit.
Only enable triggers selected by your team. This example starts manually:

```yaml
name: Evaluations
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  evals:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: github/evals-action@<reviewed-full-commit-sha>
        with:
          command: run
          working-directory: .
          suite: regression
          vally-version: 0.19.0
        env:
          COPILOT_GITHUB_TOKEN: ${{ secrets.EVALS_COPILOT_TOKEN }}
```

Model-backed execution consumes the team's account resources. Use a protected
GitHub environment if approval is required. For a model-free suite using Vally's
`mock` executor and deterministic graders, omit the token.

For lint, use `command: lint` with `eval-paths: path/to/eval.yaml`, no suite,
execution overrides or evaluator credentials. Native lint can load configured
grader plugins; it is not a sandbox for untrusted code.

## Inputs

| Input | Meaning |
| --- | --- |
| `command` | Required: `lint` or `run`. Reserved `plan` explicitly errors. No implicit run. |
| `working-directory` | Required project path relative to checkout, resolving inside it. Use `.` for the root. |
| `suite` | Native named suite for run; mutually exclusive with paths and tags. |
| `eval-paths` | Newline-separated literal paths. Spaces, including leading/trailing spaces, are preserved. Run expects eval files; lint also accepts directories. |
| `tags` | Newline-separated native filters, e.g. `cost=free` or `flaky!=yes`; run only. |
| `vally-version` | `latest` stable by default, or an exact stable version such as `0.19.0`. |
| `model` | Native model override, including Vally's comma-separated model list. |
| `runs`, `workers`, `timeout` | Positive integer run overrides. Timeout is per trial in seconds. |
| `max-retries` | Nonnegative native run override. Vally controls conditional retries and unsupported combinations. |
| `credential-env` | Additional evaluator credential environment variable **names**, one per line, passed only to run. Values belong in workflow secret references, never this input. |
| `comment` | Default `false`; opt in to a serialized bot-owned PR report. |
| `report-token` | No default. Explicit reporting-only GitHub App/bot token, normally `${{ github.token }}`. Human/PAT reporters are refused. |
| `report-id` | Stable identity within a job; default `evals`. Letters, digits, `_`, `-`; 1-64 characters. Comments require unique literal values and non-matrix jobs. |
| `upload-transcripts` | Default `false`. Opt in to native JSONL and stdout/stderr logs, potentially containing sensitive data. |
| `artifact-retention-days` | 1-90, default 7; subject to repository retention policy. |

At least one selector is required. Omitted execution overrides preserve native
configuration/defaults. Trials are not API calls or currency; this Action does
not impose or promise a dollar/token budget.

## Outcomes and evidence

The run must have a unique terminal native `run-summary`, matching run IDs,
consistent trial/group counts and native verdicts. A native failure fails the
step even if its process exits zero. Native operational errors, nonzero exit
with a passing summary, invalid configuration, and missing/malformed evidence
also fail. No report-only failure override is provided.
Ungraded trials follow Vally's native semantics; a passing run does not imply
that every stimulus configured graders. Native grader operational errors remain
errors rather than ordinary failed verdicts.

Successful lint is `validated`, **not an evaluation pass**. Proven zero-execution
results with complete native evidence and exit zero warn and report `not-run`.
This nonblocking result can satisfy branch protection; it is not a pass.
Vally 0.19.0 sometimes reports zero discovery/tag matches with exit 1 or no
terminal JSONL. Those remain errors: the Action does not guess from human log
messages or soften an ambiguous native failure. Missing suites remain errors.

Outputs:

| Output | Meaning |
| --- | --- |
| `outcome` | `validated`, `passed`, `failed`, `error`, `cancelled`, or `not-run`. |
| `plan-completeness` | Completeness of terminal native evidence, not a pre-execution preview. Lint is `unknown`. |
| `executed` | Number of non-skipped trial records, including repetitions; absent when unknown. |
| `passed`, `failed` | Counts of executed native eval/variant/model **groups**, using native verdicts; absent when unknown. |
| `vally-version` | Concrete acquired CLI version. |
| `result-path`, `artifact-id` | Minimal structured report and uploaded artifact identifier. |
| `native-diagnostics-path` | Local native logs/output directory under runner temporary storage. |

Default artifacts contain only operation status, revision, selected engine and
dependency identities, known counts, native verdicts and hashed group identities.
They exclude prompts, source paths, raw runner JSON and exception text. Native
JSONL remains the canonical local evidence; the projection is not a new run format.
Run JSONL above 64 MiB is explicitly rejected by this adapter rather than
partially parsed or treated as complete.

With `upload-transcripts: true`, CLI stdout/stderr (including run JSONL,
trajectories and grading evidence) are uploaded separately. This does not upload
the entire native workspace tree. Raw logs may contain credentials or proprietary
content; perfect redaction is not guaranteed. Cancellation forwards a signal to
Vally and permits cleanup before forced termination; hard job cancellation can
prevent final artifacts/comments.

## Trust and credentials

Use only trusted, reviewed own-repository code. Fork PRs and
`pull_request_target` are excluded before acquisition. The checkout revision is
checked before installation and again before execution. Workflow preparation
may intentionally modify working files; the reported revision is not a hash of
all resulting working content.

The native CLI can load project plugins, execute setup commands, and invoke
executors/graders. An explicit `run` step is the team's authorization; environment
filtering is not an OS sandbox and same-repository origin alone is not a trust
decision. Do not pass secrets to unreviewed code.

`COPILOT_GITHUB_TOKEN` is forwarded only to run. The automatic Actions token is
not model authentication. For BYOK/custom native providers, explicitly list
their credential variable names in `credential-env`. Reporting tokens and
protected process/GitHub environment variables cannot be forwarded this way.
Version checks, lint and installation receive neither evaluator nor PR tokens.
Vally usage telemetry is opted out for Action invocations.

Copilot-backed execution needs a customer-managed supported token. Consult the
[official authentication guidance](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).
Live model/account compatibility is not claimed by the model-free controls.
Custom native plugins, executor prerequisites and project dependencies remain
explicit workflow preparation; the Action does not install them automatically.

## Optional sticky PR reporting

Use literal `comment: true`, explicit `report-token: ${{ github.token }}`, and
job permissions `contents: read` plus `pull-requests: write`. Keep this token
separate from evaluator credentials. The exact workflow-level policy is:

```yaml
concurrency:
  group: evals-${{ github.workflow_ref }}
  cancel-in-progress: false
```

The immutable workflow source is checked before writing. Comments support
non-matrix/non-reusable jobs and unique literal report IDs. Parallel jobs have
distinct identities. Recognized Action references are
`github/evals-action@...` and root `./`. Unsupported or ambiguous topology warns
without a write.

The client reads all comments, verifies authenticated bot ownership, and creates
once or updates in place. Identity includes repository, workflow path, job,
selection hash and report ID. Stored run/attempt ordering prevents stale
replacement; the current PR revision is refreshed before writing. Human comments
are never edited. Each report links the exact revision, run and structured
artifact. Ambiguous writes are not retried. Optional failures warn without
changing the evaluation outcome. Networking tests use synthetic GitHub responses;
live bot-token qualification is separate.

## Acquisition and development

Latest stable resolves once per private job directory; exact pins coexist.
Installation is script-suppressed and isolated from customer manifests and npm
configuration. Registry integrity must match the lockfile. Atomic receipts bind
the CLI, Node/platform identity, exact dependency lock and installed tree.
Every reuse verifies those hashes; stale/corrupt receipts or locks fail rather
than silently downgrading or substituting a different graph. No cross-job cache
is restored. Registry integrity is not publisher attestation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the named CI checks and reproducible
bundle verification, and [SECURITY.md](SECURITY.md) for private reporting.

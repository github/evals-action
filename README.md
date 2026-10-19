# Evals Action

Acquire Vally and invoke its native CLI from GitHub Actions. The Action handles
installation, GitHub reporting and artifacts; **Vally owns selection, execution
and grading**. No separate Runtime/Core package is required.

Initial supported host: **Linux x64 GitHub-hosted runners, Node 24**. This is
development code, not a published Marketplace release. Repository access is
required while the repository is private. Pin a reviewed full commit SHA.

## Included real Copilot example

[`examples/copilot-smoke`](examples/copilot-smoke) contains one real skill and
one tightly bounded eval. The
[`Copilot E2E`](.github/workflows/copilot-e2e.yml) workflow automatically lints
and runs it for same-repository pull requests that change the Action or example,
and also supports manual dispatch.

The run consumes Copilot AI credits. It uses the automatic workflow token with
`copilot-requests: write`, one trial, one worker, zero retries, a 60-second
native timeout, no PR-write permission, no report token and no transcript upload.
Fork PRs do not run the jobs. See the example README for the exact contract.
This repository explicitly treats contributors who can push same-repository PR
branches affecting those paths as trusted to trigger the bounded live control.
That repository-specific decision does not change the consumer guidance below:
same-repository origin by itself is not a general-purpose authorization policy.

## Commands

| Action command | Native command | Supported selection |
| --- | --- | --- |
| `lint` | `vally lint --eval-spec=<working-directory>` | All evals discovered recursively under the project directory using native filename patterns. No selector required. |
| `run` | `vally eval --require-pass --output=jsonl ...` | A named suite, explicit eval files, or native tags. |
| `plan` | None | Explicit error: Vally 0.19.0 exposes no plan/dry-run CLI. It never falls back to a run. |
| `all` | Reusable workflow only | Lint first, then run after successful lint; low-level Action has no `all` command. |

`run` passes native options as argument-array values, never interpolated shell
commands. It does not parse `.vally.yaml`, expand shell globs, install custom
project packages, or introduce a second evaluation runner. `--suite` cannot
combine with paths or tags. Paths and tags can combine using Vally's semantics.
Put native file patterns in a named suite rather than `eval-paths`.

The adapter defaults to and has model-free native qualification against Vally
**0.19.0**,
including actual lint, suites, repetitions, multiple mock models, weighted
threshold pass, failed verdict, skipped selection and missing-suite controls.
The default is intentionally pinned so a privileged workflow does not execute a
new mutable registry release without review. `vally-version: latest` remains an
explicit opt-in; it is not a compatibility promise for future versions.

## Simplest workflow: reusable workflow

The reusable workflow defaults to `command: all`: it lints first, then runs the
selected eval, and posts separate sticky lint and run statuses on pull requests.
If lint fails, it skips the model-backed eval, reports the lint failure, and
fails the workflow. Set `command: lint` to lint without Copilot permission or
model use, or `command: run` to run without linting.

```yaml
name: Evaluations
on:
  pull_request:
    paths:
      - evals/**
      - .github/workflows/evals.yml
  workflow_dispatch:

permissions:
  contents: read

jobs:
  evals:
    uses: github/evals-action/.github/workflows/evals.yml@<reviewed-full-workflow-sha>
    with:
      working-directory: evals
      suite: smoke
      # command defaults to all; optionally choose lint or run
    permissions:
      contents: read
      copilot-requests: write
      pull-requests: write
```

Pin the private reusable workflow to a reviewed full commit SHA. The caller's
job permissions are the maximum authority delegated to that workflow. Its
actual jobs narrow their tokens: lint receives contents read, the evaluator
receives Copilot permission but no PR-write, and the report job receives
PR-write but no Copilot permission. The report job downloads the digest-bound
artifact itself; consumers do not write verdict scripts or artifact plumbing.
Private repository sharing settings must allow the consumer repository.
Do not use `secrets: inherit`; the reusable workflow needs no caller secrets.

**The default `all` can consume Copilot credits.** The workflow calls the
Action's `copilot-token` internally from `${{ github.token }}`; consumers do
not pass a model token. The caller still controls triggers, and
`command: lint` opts out of model use.

For selector overrides, set `eval-paths` and/or `tags` instead of `suite`.
The reusable workflow also accepts optional `model`, `runs`, `workers`,
`timeout`, `max-retries`, and `vally-version` overrides. Quote numeric values
such as `max-retries: '0'`. More complex workflow
topologies can use the low-level Action below.

## Low-level Action example (advanced)

Use the low-level Action when you want to compose commands or permissions
yourself. `command` remains required on the Action; it accepts `lint`, `run`,
or `report` and does not have a default. Replace
`<reviewed-full-commit-sha>` with a reviewed Action commit. This example starts
manually and runs an eval:
For organization-owned repositories, first enable the Copilot policy
**Allow use of Copilot CLI billed to the organization**. No PAT or stored
model secret is required for this workflow-token authentication path.

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
    permissions:
      contents: read
      copilot-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: github/evals-action@<reviewed-full-commit-sha>
        with:
          command: run
          working-directory: .
          suite: regression
          copilot-token: ${{ github.token }}
```

Model-backed execution consumes account resources. Workflow-token usage in
organization repositories is billed directly to the organization, not an
individual user's budget; in personal repositories it is billed to the owner's
Copilot seat. Use a protected GitHub environment if approval is required.
For a model-free suite using Vally's `mock` executor and deterministic graders,
omit both the token and `copilot-requests` permission.

The example leaves PR commenting disabled and does not grant PR-write access.
The runtime must be recent enough to support installation tokens. The
model-free checks verify credential transport, not organization policy,
entitlement, model availability or actual billing; those need a separately
approved live pilot. See [GitHub's Actions authentication guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions).

For lint, use only `command: lint` and `working-directory: .`. It always scans
all evals under that directory using Vally's configured filename patterns.
Any supplied suite, eval-paths or tags are ignored with a warning, never used
to narrow lint. Execution overrides are unsupported; do not supply evaluator
credentials. Native lint can load configured
grader plugins; it is not a sandbox for untrusted code.

## Inputs

| Input | Meaning |
| --- | --- |
| `command` | Required: `lint`, `run`, or `report`. Reserved `plan` explicitly errors. No implicit run. |
| `working-directory` | Project path relative to checkout, resolving inside it. Required for lint/run; omitted for report. |
| `suite` | Native named suite for run; mutually exclusive with paths and tags. |
| `eval-paths` | Newline-separated literal eval file paths for run. Spaces, including leading/trailing spaces, are preserved. Ignored for lint. |
| `tags` | Newline-separated native filters, e.g. `cost=free` or `flaky!=yes`; run only. |
| `vally-version` | Exact stable version; default `0.19.0`, the currently qualified and dependency-locked CLI. `latest` is accepted only when it resolves to a version with a committed reviewed lock. |
| `model` | Native model override, including Vally's comma-separated model list. |
| `runs`, `workers`, `timeout` | Positive integer run overrides. Timeout is per trial in seconds. |
| `max-retries` | Nonnegative native run override. Vally controls conditional retries and unsupported combinations. |
| `credential-env` | Advanced evaluator credential environment variable **names**, one per line, passed only to run. Use for BYOK or a supported secret-backed token; never put values in this input. Cannot list `COPILOT_GITHUB_TOKEN` when `copilot-token` is supplied. |
| `copilot-token` | Explicit Copilot token for run, normally `${{ github.token }}` with `copilot-requests: write`. The Action masks it and maps it to the SDK's `COPILOT_GITHUB_TOKEN` environment path. Cannot be reused as `report-token`. |
| `report-token` | No default. Reporting-only GitHub App/bot token, normally `${{ github.token }}` in a separate report job. Human/PAT reporters are refused. |
| `report-id` | Stable identity across evaluate/report jobs; default `evals`. Letters, digits, `_`, `-`; 1-64 characters. |
| `source-artifact-id` | Positive structured-report artifact ID. The report command downloads this artifact directly; required for report. |
| `source-artifact-digest` | 64-character lowercase SHA-256 digest emitted with the artifact ID. The report command verifies it before reading evidence; required for report. |
| `upload-transcripts` | Default `false`. Opt in to native JSONL and stdout/stderr logs, potentially containing sensitive data. |
| `artifact-retention-days` | 1-90, default 7; subject to repository retention policy. |

Run requires at least one selector; lint does not. All selection inputs are
ignored for lint with a visible warning. Omitted execution overrides preserve native
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
| `result-path`, `artifact-id`, `artifact-digest` | Minimal structured report path plus its uploaded artifact identifier and SHA-256 digest. |
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

Use only trusted code under a deliberate repository policy. Fork PRs and
`pull_request_target` are excluded before acquisition. The checkout revision is
checked before installation and again before execution. Workflow preparation
may intentionally modify working files; the reported revision is not a hash of
all resulting working content.

The native CLI can load project plugins, execute setup commands, and invoke
executors/graders. An explicit `run` step is the team's authorization; environment
filtering is not an OS sandbox and same-repository origin alone is not a trust
decision. This repository's bounded example documents an explicit exception for
contributors with same-repository branch push access; consumers must choose and
enforce their own authorization boundary. Do not pass secrets to untrusted code.

`copilot-token` is never implicit. GitHub supports the automatic Actions token
for Copilot with `copilot-requests: write` and the applicable organization
policy. Pass `${{ github.token }}` through the input as shown above. The Action
masks it, removes its Actions input environment variable, and maps it to
`COPILOT_GITHUB_TOKEN` only for the Vally run child. It does not forward
`GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_COPILOT_API_TOKEN`. This keeps installation
tokens in the SDK's environment authentication path rather than its user-token
option. Inspection of Vally 0.19.0's subject executor and LLM judge confirms
they retain this path when the blocked token variables are absent.
See [the SDK server-to-server contract](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens).

The explicit Copilot input may have the same value as the parent process's
`GITHUB_TOKEN`; that variable itself is never forwarded. A token equal to
`report-token`, `GH_TOKEN` or the artifact-service token is still rejected. In
particular, do not give the same token to both `report-token` and `copilot-token`.
The Action cannot remove permissions from a token or attest its scopes; the
workflow author must grant only `contents: read` and `copilot-requests: write`
to the model job, not `pull-requests: write` or `write-all`.

For BYOK/custom native providers, explicitly list their credential variable
names in `credential-env`. Reporting tokens and protected process/GitHub
environment variables cannot be forwarded this way.
Version checks, lint and installation receive neither evaluator nor PR tokens.
Vally usage telemetry is opted out for Action invocations.

If workflow-token authentication is unavailable under your account's policy,
an explicitly provisioned supported user token remains an alternative: replace
`${{ github.token }}` in `copilot-token` with
`${{ secrets.EVALS_COPILOT_TOKEN }}` and omit the Copilot workflow permission
when it is not used. For custom provider variables or advanced environment
contracts, use `credential-env`. There is no automatic fallback to stored
personal credentials. Consult the
[official authentication guidance](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).
Live model/account compatibility is not claimed by the model-free controls.
Custom native plugins, executor prerequisites and project dependencies remain
explicit workflow preparation; the Action does not install them automatically.

## PR status comments

Prefer the reusable workflow above. It posts one sticky status comment per
selected command from an isolated report job and preserves native job failures
without a separate verdict job.

For advanced callers using the low-level Action, keep reporting in a distinct
job with `contents: read` and `pull-requests: write`, but no
`copilot-requests: write`. The evaluator job must not have PR-write permission.
Expose `artifact-id` and `artifact-digest` from the evaluator step as job
outputs, then use:

```yaml
- uses: github/evals-action@<reviewed-action-sha>
  with:
    command: report
    source-artifact-id: ${{ needs.evaluate.outputs.artifact-id }}
    source-artifact-digest: ${{ needs.evaluate.outputs.artifact-digest }}
    report-token: ${{ github.token }}
```

Reporting automatically downloads the current run's exact artifact and
verifies its digest; consumers do not add a separate download action. A failed
evaluation job can still run the report job with `if: always()`. The evaluation
job's failure already fails the workflow, so no custom verdict job is needed.
On manual/non-PR events the report command is not used.

The report job must be non-matrix and use job-level serialization (already
implemented by the reusable workflow):

```yaml
concurrency:
  group: evals-${{ github.workflow_ref }}
  cancel-in-progress: false
```

`command: report` never acquires Vally or starts an evaluator. It downloads the
current run's artifact by ID, verifies the upload digest, requires the artifact
to contain exactly one bounded `report.json` (maximum 1 MiB), and accepts only
the Action's structured schema. The report ID, repository, revision, workflow
run ID, attempt and artifact identity must match the current job. Unknown/raw runner fields,
recursive report commands, inconsistent verdict/count shapes, symlink escapes
and stale PR revisions are rejected before a GitHub write.

The immutable caller workflow is checked before writing. Direct Action
reporting requires a unique literal report ID in a non-matrix serialized job.
Reusable-workflow reporting additionally validates the product workflow's
system-provided repository, path and immutable source identity, plus the
consumer's pinned reusable-workflow call and minimal permission ceiling.
Unsupported or ambiguous topology fails before a GitHub write.

The client reads all comments, verifies authenticated bot ownership, and creates
once or updates in place. Identity includes repository, workflow path, job,
selection hash and report ID. Stored run/attempt ordering prevents stale
replacement; the current PR revision is refreshed before writing. Human comments
are never edited. Each report links the exact revision, run and structured
artifact. Ambiguous writes are not retried. The evaluation's native outcome remains in
its structured artifact even when reporting fails; the reporting job surfaces
its own failure. Networking tests use synthetic GitHub
responses, and the repository's Copilot E2E workflow qualifies the bot-token
comment path independently from evaluator permissions.

## Acquisition and development

The Action currently carries one reviewed runtime graph:
`tooling/vally-0.19.0/package-lock.json`. Installation uses `npm ci`, suppresses
lifecycle scripts, and is isolated from customer manifests and npm
configuration. The committed lock's canonical digest, top-level registry
identity and every package integrity are verified before execution. A requested
exact version or `latest` resolution is refused unless it maps to a committed
reviewed lock; supporting another version requires adding and reviewing its
lock first.

Atomic receipts bind the CLI, Node/platform identity, committed dependency lock
and installed tree.
Every reuse verifies those hashes; stale/corrupt receipts or locks fail rather
than silently downgrading or substituting a different graph. No cross-job cache
is restored. Registry integrity is not publisher attestation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the named CI checks and reproducible
bundle verification, and [SECURITY.md](SECURITY.md) for private reporting.

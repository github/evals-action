# Evals Action

One GitHub Action to validate, lint, run your Vally evals, and update **one
sticky PR comment** with the suite, eval names, verdicts, and evidence links.
Vally owns selection, execution and grading; the Action handles installation
and GitHub integration.

Supported host: **Linux x64 GitHub-hosted runners, Node 24**. Pin a reviewed
full Action commit SHA. This repository is private development code, not a
published Marketplace release; organization Actions access must permit your
consumer repository.

## Quick start

One job, one checkout, one Action step. `command` defaults to `all`:
validate configuration, lint the project, run the selected evals if lint
succeeds, and post the result on PRs. Manual runs produce summaries and
artifacts without attempting to comment.

```yaml
name: Evals
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
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      copilot-requests: write
      pull-requests: write
    concurrency:
      group: evals-${{ github.workflow_ref }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: github/evals-action@<reviewed-full-commit-sha>
        with:
          working-directory: evals
          suite: smoke
```

Replace the SHA, project path and suite with your own. No reusable workflow,
custom verdict script, artifact plumbing, or manually supplied token is needed.
The Action's `github-token` input defaults to `${{ github.token }}`. The
non-cancelling concurrency group serializes updates to the sticky comment.

Vally defaults to the registry's **latest stable release**. To select an exact
version instead, add `vally-version`:

```yaml
      - uses: github/evals-action@<reviewed-full-commit-sha>
        with:
          working-directory: evals
          suite: smoke
          vally-version: '0.20.0'
```

This requests that exact version once it is published; it does not require an
Action update. New versions work while the native CLI and evidence contracts
remain compatible. Unsupported behavior or malformed evidence fails explicitly;
there is no silent downgrade. Stable exact versions and `latest` are supported,
not version ranges or prereleases.

**Default `all` mode can incur Copilot usage charges.** Organization repositories
need the **Allow use of Copilot CLI billed to the organization** policy.
Organization workflow-token usage is billed to the organization; personal
repository usage is billed to the owner's Copilot seat. Native overrides remain
optional. `all` defaults to zero retries; explicit `run` retains Vally's default
unless `max-retries` is provided. Trials are not API calls or a currency budget.

**Simple mode deliberately combines permissions.** The evaluator's automatic
token can also write PR comments. Trusted eval setup, plugins and model tools
may access that token. This is convenient, not credential isolation. Use only
trusted reviewed sources, grant no unnecessary permissions, and use separate
commands/jobs below when you need a narrower model token.

## Included end-to-end example

[`copilot-e2e.yml`](.github/workflows/copilot-e2e.yml) directly invokes this
repository's Action (`uses: ./`) with `command` omitted. It tests the same
simple interface consumers use against [`examples/copilot-smoke`](examples/copilot-smoke):
one real skill, one trial, a 60-second native timeout, and zero retries.
It runs for relevant same-repository PRs or manual dispatch, never forks.
The skill invocation and exact response are both graded.

This is a test of the Action, not a reusable workflow for consumers to call.
There is no intermediate workflow wrapper.

## Commands

| `command` | Behavior |
| --- | --- |
| Omitted / `all` | Validate inputs, lint, run after successful lint, publish evidence, and update the PR comment. Lint failure skips the eval and reports the failure. |
| `lint` | Native `vally lint --eval-spec=<working-directory>`. Scans all evals recursively, needs no selector or model credentials. Publishes a summary and artifact, without commenting. |
| `run` | Native `vally eval --require-pass --output=jsonl ...`. Requires a suite, eval paths or tags. Publishes a summary and artifact, without commenting. |
| `report` | Download and verify structured artifacts, then update the same sticky comment. Never installs Vally or runs a model. PR events only. |
| `plan` | Explicit error: Vally 0.19.0 has no plan/dry-run CLI. Never falls back to a run. |

Native arguments are separate argv values, never interpolated shell commands.
The Action does not parse `.vally.yaml`, implement grading, expand shell globs,
or install custom project dependencies. A suite cannot combine with paths/tags;
paths and tags can combine using Vally's native syntax. Put native glob patterns
in a suite rather than `eval-paths`. Lint ignores selectors with a warning;
explicit lint rejects execution overrides.

## Optional permission isolation

The **same Action** can be used in separate jobs. There is no custom verdict
job: a failed lint or run job already makes the workflow fail, while
`if: always()` allows reporting after that failure.

| Job | Action command | Job permissions |
| --- | --- | --- |
| Lint | `lint` | `contents: read` |
| Evaluate | `run` | `contents: read`, `copilot-requests: write` |
| Comment | `report` | `contents: read`, `pull-requests: write` |

In the lint job, use `report-id: evals-lint`. In the run job use
`report-id: evals-run`, `copilot-token: ${{ github.token }}`, and make it depend
on successful lint. Each execution job checks out the consumer repository
because GitHub jobs have separate filesystems. Expose each step's `artifact-id`
and `artifact-digest` as job outputs. The reporting job needs **no checkout**
and can use the following complete job (assuming job IDs `lint` and `run`):

```yaml
  report:
    needs: [lint, run]
    if: always() && github.event_name == 'pull_request' && (needs.run.outputs.artifact-id != '' || needs.lint.outputs.artifact-id != '')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    concurrency:
      group: evals-${{ github.workflow_ref }}
      cancel-in-progress: false
    steps:
      - uses: github/evals-action@<reviewed-full-commit-sha>
        with:
          command: report
          report-id: evals-run
          source-artifact-id: ${{ needs.run.outputs.artifact-id }}
          source-artifact-digest: ${{ needs.run.outputs.artifact-digest }}
          lint-artifact-id: ${{ needs.lint.outputs.artifact-id }}
          lint-artifact-digest: ${{ needs.lint.outputs.artifact-digest }}
        if: always() && needs.run.outputs.artifact-id != ''
      - uses: github/evals-action@<reviewed-full-commit-sha>
        with:
          command: report
          report-id: evals-lint
          source-artifact-id: ${{ needs.lint.outputs.artifact-id }}
          source-artifact-digest: ${{ needs.lint.outputs.artifact-digest }}
        if: always() && needs.run.outputs.artifact-id == '' && needs.lint.outputs.artifact-id != ''
```

The two report steps are mutually exclusive: either report both results or
report only the lint failure. Both use the same comment identity `evals`.
Do not give the run job PR-write permission if you want isolation. Explicit
`run` does not consume the automatic `github-token`; pass `copilot-token` or
name advanced credentials explicitly. `report` uses its own automatic job
token, or an explicit `report-token` override.

## Inputs

| Input | Meaning |
| --- | --- |
| `command` | Optional; defaults to `all`. Also `lint`, `run`, `report`; `plan` is unsupported. |
| `working-directory` | Required for all/lint/run; project path relative to checkout, resolving inside it. Omit for report. |
| `suite` | Native suite for all/run; mutually exclusive with paths/tags. |
| `eval-paths` | Newline-separated literal paths for all/run. Spaces are preserved. No shell expansion. |
| `tags` | Newline-separated native filters for all/run, e.g. `cost=free` or `flaky!=yes`. |
| `github-token` | Defaults to `${{ github.token }}`. Used for model auth and PR reporting in all; reporting only in report; not forwarded in explicit lint/run. |
| `copilot-token` | Optional explicit model token. Overrides automatic model auth in all; required for workflow-token auth in explicit run. |
| `credential-env` | Advanced evaluator credential variable names, one per line, for BYOK/custom providers. Supplying these disables automatic model-token injection in all. Never put values here. Cannot list `COPILOT_GITHUB_TOKEN` with `copilot-token`. |
| `report-token` | Optional bot/App comment token override for all/report. Human/PAT reporters are refused. Not valid on explicit lint/run. |
| `report-id` | Stable report identity, default `evals`; letters/digits/underscore/hyphen. Maximum 64 characters (59-character prefix for all). Advanced `evals-run` / `evals-lint` share the `evals` comment. |
| `vally-version` | Default `latest`, resolved once per job to the npm latest stable release. Set an exact stable version, e.g. `0.20.0`, to pin the CLI. No per-version Action update is required. |
| `model` | Native model override, including comma-separated native model lists. |
| `runs`, `workers`, `timeout` | Positive integer native run overrides. Timeout is per trial in seconds. |
| `max-retries` | Nonnegative run override. All mode defaults to 0; explicit run preserves native default. |
| `source-artifact-id`, `source-artifact-digest` | Required for report: exact primary artifact ID and its 64-character lowercase SHA-256 digest. |
| `lint-artifact-id`, `lint-artifact-digest` | Optional paired companion lint evidence for report. The companion report ID is the primary ID prefix plus `-lint`. |
| `upload-transcripts` | Default false; opt in to raw native JSONL and stdout/stderr, potentially sensitive. |
| `artifact-retention-days` | 1-90, default 7; subject to repository retention policy. |

## Outcomes and evidence

Native terminal JSONL, run identity, trial/group counts, and native verdicts
determine the result. Failed grades fail the Action even with process exit zero.
Operational errors, malformed evidence, invalid configuration, and nonzero
exit with a passing summary also fail. Posting a successful comment does not
clear an existing native failure. Comment or required-artifact publication
failure also fails the Action without rewriting its native outcome output.

Lint success is `validated`, not an eval pass. A fully evidenced empty run with
exit zero warns and reports `not-run`: nonblocking but **not a pass**. Ambiguous
empty discovery with nonzero exit or missing JSONL remains an error. Ungraded
trials and weighted thresholds retain Vally's native semantics.

| Output | Meaning |
| --- | --- |
| `outcome` | `validated`, `passed`, `failed`, `error`, `cancelled`, or `not-run`. In all, reflects the run or lint failure. |
| `plan-completeness` | Completeness of terminal evidence, not a plan preview. Lint is unknown. |
| `executed` | Non-skipped trial count, including repetitions; absent when unknown. |
| `passed`, `failed` | Counts of executed eval/variant/model groups; absent when unknown. |
| `vally-version` | Acquired native CLI version. |
| `result-path`, `artifact-id`, `artifact-digest` | Primary structured report path and artifact identity. |
| `lint-artifact-id`, `lint-artifact-digest` | Companion lint evidence produced by all after successful lint. |
| `native-diagnostics-path` | Local raw logs/output directory under runner temporary storage. |

Structured artifacts contain status, revision, suite, bounded native eval names,
engine/dependency identities, counts, verdicts and hashed group identities.
They exclude full source paths, prompts, model output and raw exception text.
Names are Markdown-escaped in comments; do not store secrets in suite or eval
names. Comments show at most 100 groups and link to the complete artifact.
Raw JSONL above 64 MiB is refused rather than partially interpreted.

Optional transcripts may contain prompts, secrets and proprietary code.
Perfect redaction is not guaranteed. Cancellation forwards signals to the
owned process group; hard job cancellation may prevent artifacts/comments.

## Trust and authentication

Use trusted reviewed evals and select your own triggers/approval policy.
Fork PRs and `pull_request_target` are excluded before acquisition. Native lint
can load executable plugins; run can invoke setup scripts, graders, providers
and model tools. Environment filtering is not an OS sandbox. The Action
verifies checkout revision before execution, but this does not prove that
workflow preparation left every working file unchanged.

All mode deliberately shares the job token between Copilot and PR reporting.
The Action cannot remove a token's permissions. Separate jobs are an optional
hardening pattern, not a GitHub requirement. Even though credentials are
omitted from lint/version/install subprocess environments, code executing
under the same runner user is not isolated from the rest of the job.

Token inputs are masked and removed from their `INPUT_*` environment variables.
Only native run gets `COPILOT_GITHUB_TOKEN`; `GITHUB_TOKEN`, `GH_TOKEN`, artifact
service tokens and process-injection variables are not forwarded. An explicit
`copilot-token` or `credential-env` replaces automatic model authentication in
all; no stored personal credential fallback is used.

See [Copilot in Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions)
and [SDK server authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens).
Live entitlement, organization policy, subject/judge compatibility and billing
must be qualified for the consumer account; model-free controls do not prove them.

## One sticky PR report

All and report share one bot-owned comment per repository, caller workflow
path and normalized report ID, independent of command, selection or job name.
Reruns and suite changes update it. Older runs/attempts cannot overwrite newer
reports; the PR revision is refreshed before writes. Human comments are never
edited, and ambiguous writes are not retried.

The reporting job (or workflow) must use the exact non-cancelling concurrency
group shown above. Workflow source at the immutable run revision is validated;
matrix/reusable-job report topology and ambiguous report identities are refused.
Multiple report steps for one ID must be mutually exclusive, as in the advanced
example. Separate jobs using the same report ID must use the same concurrency
group.

Report mode downloads its artifacts itself, verifies digests and current
repository/revision/run/attempt identity, and accepts only a bounded
`report.json`. A companion must be successful lint from the same run/revision,
but it can originate in a separate lint job.

## Development and acquisition

Acquisition resolves `latest` or the exact requested version from npm and
records the concrete version and SHA-512 package integrity once per job.
It generates a dependency lock in a private runner temporary directory,
validates registry origins and integrity metadata, and uses
`npm ci --ignore-scripts` to install that graph. It verifies the package,
executable, installed tree and unchanged lock before execution or cache reuse.
It never clones a product branch or installs from customer manifests.

No Vally-version-specific lockfile is committed to the Action. Dependency
resolution is fresh in each job and fixed within that job; `latest` can change
between jobs. An exact CLI pin fixes the top-level package but its transitive
dependencies can still change between jobs according to upstream ranges.
Both modes trust npm and the upstream dependency graph; recorded digests are
provenance, not a claim that the graph was reviewed with the Action.

The development dependency remains pinned to Vally 0.19.0 for deterministic,
model-free CLI contract tests. It is a test fixture, not a runtime allowlist.

Use Node 24 and the pinned pnpm version. Run `pnpm check`, rebuild and commit
`dist/index.cjs`, and follow [CONTRIBUTING.md](CONTRIBUTING.md). Security reports
belong through [SECURITY.md](SECURITY.md), not public PR comments.

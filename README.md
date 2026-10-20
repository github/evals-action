# Evals Action

One GitHub Action to validate, lint, run your Vally evals, and update **one
sticky PR comment** with the suite, eval names, verdicts, and evidence links.
Vally owns selection, execution and grading; the Action handles installation
and GitHub integration.

Use `github/evals-action@v0` for the latest 0.x pilot release
(currently [v0.1.0](https://github.com/github/evals-action/releases/tag/v0.1.0)).
Use `@v0.1.0` to stay on that specific Action release. The `v0` tag advances as
new 0.x releases are published; the interface may change during the pilot.
Supported host: **Linux x64 GitHub-hosted runners**; the Action uses Node 24
without a Node setup step. The repository is private and shared with the GitHub
organization; your repository's Actions policy must allow it.

## Quick start

One job, one checkout, one Action step. `command` defaults to `all`:
validate configuration, lint the project, run the selected evals if lint
succeeds, and post the result on PRs. Manual runs produce summaries and
artifacts without attempting to comment. Save this in your repository as
`.github/workflows/evals-ci.yml`:

```yaml
name: Evals
on:
  pull_request:
    paths:
      - evals/**
      - .github/workflows/evals-ci.yml
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
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: github/evals-action@v0
        with:
          working-directory: evals
          suite: smoke
```

Replace `evals` with your Vally project directory and `smoke` with your suite.
Adjust the trigger paths to include your evals, configuration, skills and other
inputs. No command or token inputs are needed: the Action uses the job's
automatic `${{ github.token }}`. Keep the concurrency block as shown so
overlapping runs cannot create duplicate reports.

Lint checks the entire project; the suite selects which evals run. Failed lint
skips evaluation. A failed eval still updates the comment, and the job remains
failed. The comment shows the suite, eval names, trial results and evidence links.

Vally defaults to the registry's **latest stable release**. To select an exact
version instead, add `vally-version`, for example:

```yaml
with:
  working-directory: evals
  suite: smoke
  vally-version: '0.19.0' # Optional; omit for latest stable
```

The Action version (`@v0` or `@v0.1.0`) and Vally version are independent. Selecting a
published Vally release does not require an Action update. New versions work
while the native CLI and evidence contracts remain compatible.
Unsupported behavior or malformed evidence fails explicitly;
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

## Advanced: separate jobs and permissions

The **same Action** can be used in separate jobs. There is no custom verdict
job: a failed lint or run job already makes the workflow fail, while
`if: always()` allows reporting after that failure.

| Job | Action command | Job permissions |
| --- | --- | --- |
| Lint | `lint` | `contents: read` |
| Evaluate | `run` | `contents: read`, `copilot-requests: write` |
| Comment | `report` | `contents: read`, `pull-requests: write` |

This complete alternative keeps PR-write permission out of the evaluator job.
Each execution job needs a checkout because jobs have separate filesystems;
the reporting job does not. All tokens below are GitHub-generated job tokens,
not PATs or stored secrets.

<details>
<summary>Show the three-job workflow</summary>

```yaml
name: Evals
on:
  pull_request:
    paths:
      - evals/**
      - .github/workflows/evals-ci.yml
  workflow_dispatch:

permissions:
  contents: read

jobs:
  lint:
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    outputs:
      artifact-id: ${{ steps.lint.outputs.artifact-id }}
      artifact-digest: ${{ steps.lint.outputs.artifact-digest }}
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: github/evals-action@v0
        id: lint
        with:
          command: lint
          working-directory: evals
          report-id: evals-lint

  run:
    needs: lint
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      copilot-requests: write
    outputs:
      artifact-id: ${{ steps.run.outputs.artifact-id }}
      artifact-digest: ${{ steps.run.outputs.artifact-digest }}
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: github/evals-action@v0
        id: run
        with:
          command: run
          working-directory: evals
          suite: smoke
          report-id: evals-run
          copilot-token: ${{ github.token }}
          max-retries: 0

  report:
    needs: [lint, run]
    if: always() && github.event_name == 'pull_request' && (needs.run.outputs.artifact-id != '' || needs.lint.outputs.artifact-id != '')
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      pull-requests: write
    concurrency:
      group: evals-${{ github.workflow_ref }}
      cancel-in-progress: false
    steps:
      - uses: github/evals-action@v0
        with:
          command: report
          report-id: evals-run
          source-artifact-id: ${{ needs.run.outputs.artifact-id }}
          source-artifact-digest: ${{ needs.run.outputs.artifact-digest }}
          lint-artifact-id: ${{ needs.lint.outputs.artifact-id }}
          lint-artifact-digest: ${{ needs.lint.outputs.artifact-digest }}
        if: always() && needs.run.outputs.artifact-id != ''
      - uses: github/evals-action@v0
        with:
          command: report
          report-id: evals-lint
          source-artifact-id: ${{ needs.lint.outputs.artifact-id }}
          source-artifact-digest: ${{ needs.lint.outputs.artifact-digest }}
        if: always() && needs.run.outputs.artifact-id == '' && needs.lint.outputs.artifact-id != ''
```

</details>

The two report steps are mutually exclusive: either report both results or
report only the available lint evidence. Both use the same comment identity `evals`.
Do not give the run job PR-write permission if you want isolation. Explicit
`run` does not consume the automatic `github-token`; pass `copilot-token` or
name advanced credentials explicitly. `report` uses its own automatic job
token, or an explicit `report-token` override.

The explicit `run` step sets `max-retries: 0` to match simple mode; otherwise
explicit run retains Vally's retry default. If eval execution cannot produce an
artifact, only the available lint evidence is reported; the failed run job is
still visible in GitHub checks.

## Commands

| `command` | Behavior |
| --- | --- |
| Omitted / `all` | Validate inputs, lint, run after successful lint, publish evidence, and update the PR comment. |
| `lint` | Native whole-project lint. No selector or model credentials needed. Publishes a summary and artifact, without commenting. |
| `run` | Native `vally eval --require-pass --output=jsonl ...`. Requires a suite, eval paths or tags. Publishes a summary and artifact, without commenting. |
| `report` | Verify structured artifacts and update the sticky comment. Never installs Vally or runs a model. PR events only. |
| `plan` | Reserved and unsupported; fails explicitly, never runs an eval. |

Native arguments are separate argv values, never interpolated shell commands.
The Action does not parse `.vally.yaml`, implement grading, expand shell globs,
or install custom project dependencies. A suite cannot combine with paths/tags;
paths and tags can combine using Vally's native syntax. Put native glob patterns
in a suite rather than `eval-paths`. Lint ignores selectors with a warning;
explicit lint rejects execution overrides.

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
| `vally-version` | Default `latest`, resolved once per job to the npm latest stable release. Set an exact published stable version to pin the CLI. No per-version Action update is required. |
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

## Example skill and eval

[`examples/copilot-smoke`](examples/copilot-smoke) contains a real skill and an
eval that checks both skill invocation and exact output. This repository's
[`Copilot E2E` workflow](.github/workflows/copilot-e2e.yml) tests it with one
checkout and one `uses: ./` step, using the Action's defaults. In your repository,
use `github/evals-action@v0` instead.

The Action prerelease is private and not listed on Marketplace. Organizations
that require full-SHA Action references can pin the release commit
`83fa12332c3e44ad899f347eaf153a0d9b6432dc` for `v0.1.0`.

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

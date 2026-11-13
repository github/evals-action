# Contributing

Contributions to this project are
[released](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)
to the public under the [project's open source license](LICENSE). Follow
[this project's Contributor Code of Conduct](CODE_OF_CONDUCT.md).
Search existing issues before proposing substantial work. Report security
issues privately using [SECURITY.md](SECURITY.md), not the public issue tracker.

Use Node 24 and the exact Corepack-managed pnpm version in `package.json`.
This is one package and one lockfile, not a copy of the product monorepo.

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm build
pnpm check
```

`pnpm check` runs type checking, lint, model-free coverage, deterministic
source-to-bundle comparison, and a clean consumer-directory packaging control.
The clean consumer-directory packaging control deliberately lacks artifact
credentials and verifies invalid-input failure. Linux CI separately exercises
the packaged Action with real Vally acquisition, native mock-executor pass/fail
and lint, plus hosted artifact upload. Do not add model credentials to the
model-free workflow or unit-test fixtures. The separate Copilot E2E workflow
uses its automatic job token for the approved live example.

PR check names map directly to these commands:

| Check | Command and purpose |
| --- | --- |
| Lint | `pnpm lint`: source/test lint rules. |
| Type check | `pnpm typecheck`: strict TypeScript validation. |
| Unit tests | `pnpm test:coverage`: input, policy, reporting, mocked GitHub, tool reuse, orchestration and real model-free native CLI tests with coverage thresholds. |
| Bundle verification | `pnpm check:package`: committed bundle freshness and a clean consumer-directory packaged entry-point test. |
| Action smoke test | Executes `uses: ./` on Ubuntu with actual acquisition, native mock-executor pass/fail, lint, installation reuse and artifact upload. No models run. |
| evals (Copilot E2E workflow) | For relevant same-repository PRs, directly invokes the default Action on the example. This consumes organization Copilot AI credits. |

Comment networking tests use synthetic GitHub responses, including serialized
workflow guards, pagination, bot ownership, late runs/attempts, permission
failures and readback. Installer tests use synthetic packages and exercise
concurrent install/reuse and tampered files/receipts. `tests/native.test.ts`
separately qualifies the real pinned Vally CLI with the built-in mock executor
and deterministic graders. Unit tests do not establish live GitHub token acceptance.
The live `Copilot E2E` workflow directly exercises the default Action with one
checkout and one `uses: ./` step. It deliberately uses combined Copilot and
PR-write permissions in one job, just like the simplest consumer setup.
Default mode validates, lints, runs only after successful lint, and updates one
sticky comment containing suite, native eval names, and lint/run statuses.
Unit tests also cover explicit commands for users who choose isolated jobs.
Report discovery must remain scoped to the current workflow run and attempt,
match the shared report identity and command, and verify the API-provided
digest and downloaded report identity. Refuse ambiguous or missing evidence;
never choose the newest match or reuse a prior attempt. Preserve explicit
ID/digest pairs as a discovery-free path. Discovery tests use synthetic
artifact listings; do not require live tokens or model execution.

Commit `dist/index.cjs` and its generated license notices. This is an intentional
JavaScript Action distribution exception: consumers execute committed `dist`
without installing this repository. `pnpm check:dist` compares build bytes with
the checked-in bundle. Never hand-edit generated files. Update the source,
rebuild, and review both source and distribution changes.

The build also generates `dist/THIRD-PARTY-NOTICES.txt` and
`dist/bundled-dependencies.json` from inputs with positive byte contributions to
esbuild's executable output, excluding completely tree-shaken modules, alongside
the existing inline notices in `dist/index.cjs.LEGAL.txt`. Commit all generated
outputs; `pnpm check:dist` verifies them together. The version-bound
supplement for `@nodable/entities` comes from the license at its npm-published
`gitHead`; keep that provenance with any update.
Attribution-only `NOTICE` and `COPYRIGHT` files are retained separately; they
do not suppress license fallbacks or resolve missing license terms.
The version-bound protobuf runtime source headers retain the Google and
protobuf.js BSD terms alongside the package's Apache license, rather than
treating one license file as evidence for every declared component.

Entries marked `missing-license-text` are unresolved public-release blockers,
not approved exceptions. A passing build or packaging test does not clear them.
Obtain authoritative terms and release-owner disposition; do not infer a
license from a dependency's parent, another distributor, or a package name.
The packaging regression records the current three gaps so dependency changes
require an explicit reassessment.

Use strict TypeScript, argument-array process invocation, and exact dependencies.
Use `actions/checkout@v7`; other third-party Actions remain SHA-pinned.
Do not log raw evaluator/process output or
copy native runtime behavior into the Action. New native capabilities require
verified CLI arguments/output contracts and model-free integration controls.
Only trusted same-repository code may receive execution credentials;
environment filtering is not an OS sandbox.

The repository's `Copilot E2E` workflow is an explicitly approved live control
for same-repository PRs affecting the Action or example. Keep it to one
stimulus, one trial, one worker, zero retries and the documented timeout. Do not
broaden its triggers, permissions, transcript upload or workload without a new
approval. Fork PRs remain excluded. This repository deliberately treats
contributors who can push same-repository PR branches affecting the bounded
workflow/example paths as trusted to trigger this live control. Protect that
capability through repository write access and branch governance.

## Release preparation

The first prerelease is [`v0.1.0`](https://github.com/github/evals-action/releases/tag/v0.1.0).
Keep published version tags unchanged. For future releases, verify the packaged
Action at the target commit and update consumer examples to the intended tag.
Action release versions are independent of the selected Vally version.

The moving `v0` tag points to the latest approved 0.x release. After publishing
a new 0.x minor or patch release and verifying its checks, advance only `v0`
to that release's exact commit. Verify the tag target afterward. Do not move
version-specific tags, publish a separate GitHub release for the moving tag,
or use a blanket force-push of all tags. Release publication and advancing the
alias are separate steps; no automatic tag-moving workflow is configured.
Keep `v0` on the 0.x line when introducing a future `v1` release.

Before proposing a release, verify supported CLI versions and their native
evidence contracts, run the Linux model-free controls, and qualify the optional
reporting client with the supported hosted token. Do not advertise a plan
operation or native selector combination the selected CLI does not expose.
The runtime default is `latest`; users can pin any exact stable CLI version.
Do not add a hardcoded version allowlist or require a committed Vally lock for
each release. Acquisition generates a job-local lock with lifecycle scripts
disabled, validates package integrity/dependency origins, installs with `npm ci`,
and verifies the graph on reuse. Cover newly published versions synthetically
without requiring that version to exist on npm during unit tests.
Keep the development Vally dependency pinned for deterministic model-free
contract tests, and the hosted model-free smoke on an explicit version.
The Copilot example deliberately exercises the default `latest` interface.
Workflow-token authentication controls must keep installation/lint/version
subprocess credentials absent and map model auth only to `COPILOT_GITHUB_TOKEN`.
Test the intentional shared token in all mode and explicit run's rejection of
`report-token`. The Action's `github-token` metadata default must be exercised
in the hosted example without adding a token input to the example step.
Use synthetic tokens for repository tests. A live pilot in a separate consumer
repository must separately verify subject and judge authentication, organization
policy and billing with `copilot-requests: write` and no stored personal secret.
Run `pnpm check` from a clean checkout, review dependency provenance and the
packaged delta, and document support and limitations.

Publishing, version tags, Marketplace listing, visibility/access changes, live
model validation, and credential enablement each require separate authorization.
Do not publish or claim customer availability solely because packaging CI passes.

# Contributing

Contributions are under the [MIT License](LICENSE). Follow
[GitHub's Contributor Code of Conduct](https://github.com/github/.github/blob/main/CODE_OF_CONDUCT.md).
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
and lint, plus hosted artifact upload. No model credentials belong in CI or
test fixtures.

PR check names map directly to these commands:

| Check | Command and purpose |
| --- | --- |
| Lint | `pnpm lint`: source/test lint rules. |
| Type check | `pnpm typecheck`: strict TypeScript validation. |
| Unit tests | `pnpm test:coverage`: input, policy, reporting, mocked GitHub, tool reuse, orchestration and real model-free native CLI tests with coverage thresholds. |
| Bundle verification | `pnpm check:package`: committed bundle freshness and a clean consumer-directory packaged entry-point test. |
| Action smoke test | Executes `uses: ./` on Ubuntu with actual acquisition, native mock-executor pass/fail, lint, installation reuse and artifact upload. No models run. |
| Copilot E2E | For relevant same-repository PRs, lints the example and runs one real Copilot skill eval. This consumes organization Copilot AI credits. |

Comment networking tests use synthetic GitHub responses, including serialized
workflow guards, pagination, bot ownership, late runs/attempts, permission
failures and readback. Installer tests use synthetic packages and exercise
concurrent install/reuse and tampered files/receipts. `tests/native.test.ts`
separately qualifies the real pinned Vally CLI with the built-in mock executor
and deterministic graders. No test claims live GitHub bot-token qualification.

Commit `dist/index.cjs` and its generated license notices. This is an intentional
JavaScript Action distribution exception: consumers execute committed `dist`
without installing this repository. `pnpm check:dist` compares build bytes with
the checked-in bundle. Never hand-edit generated files. Update the source,
rebuild, and review both source and distribution changes.

Use strict TypeScript, argument-array process invocation, exact dependencies,
and SHA-pinned third-party Actions. Do not log raw evaluator/process output or
copy native runtime behavior into the Action. New native capabilities require
verified CLI arguments/output contracts and model-free integration controls.
Only trusted own-repository code may eventually receive execution credentials;
environment filtering is not an OS sandbox.

The repository's `Copilot E2E` workflow is an explicitly approved live control
for same-repository PRs affecting the Action or example. Keep it to one
stimulus, one trial, one worker, zero retries and the documented timeout. Do not
broaden its triggers, permissions, transcript upload or workload without a new
approval. Never run that job for fork PRs or unreviewed native configuration.

## Release preparation

Before proposing a release, verify supported CLI versions and their native
evidence contracts, run the Linux model-free controls, and qualify the optional
reporting client with the supported hosted token. Do not advertise a plan
operation or native selector combination the selected CLI does not expose.
Workflow-token authentication controls must keep installation/lint/version
credentials absent, pass the explicit token only as `COPILOT_GITHUB_TOKEN`,
and preserve the prohibition on sharing `report-token` with model execution.
Use synthetic tokens for repository tests. A live pilot in a separate consumer
repository must separately verify subject and judge authentication, organization
policy and billing with `copilot-requests: write` and no stored personal secret.
Run `pnpm check` from a clean checkout, review dependency provenance and the
packaged delta, and document support and limitations.

Publishing, version tags, Marketplace listing, visibility/access changes, live
model validation, and credential enablement each require separate authorization.
Do not publish or claim customer availability solely because packaging CI passes.

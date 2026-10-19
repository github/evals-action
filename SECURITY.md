# Security

## Reporting a vulnerability

Send suspected vulnerabilities to
[opensource-security@github.com](mailto:opensource-security@github.com),
GitHub's reporting contact for open-source repositories. Repository collaborator
access is not required. Do not disclose vulnerabilities in public issues,
discussions, pull requests or release comments.

Include the affected Action commit, engine/runtime versions if applicable,
environment, relevant files, minimal non-destructive reproduction and impact.
Remove tokens, credentials, private project data and model traces.
Coordinate public disclosure with the security team and maintainers.

This project follows
[GitHub's open-source security policy](https://github.com/github/.github/blob/main/SECURITY.md).
Consult the current [bug bounty scope](https://bounty.github.com/scope) and
[Safe Harbor policy](https://docs.github.com/en/site-policy/security-policies/github-bug-bounty-program-legal-safe-harbor).
This repository does not promise bounty rewards, response deadlines or a
separate long-term support schedule.

## Execution boundary

The Action invokes the acquired Vally CLI directly. Use only trusted,
reviewed workflows and evaluation sources. Native project configuration can
load executable plugins, including during lint; lint does not run subjects or
judges, but it is not a sandbox. Native run may execute project setup, providers,
executors and graders. Fork jobs and `pull_request_target` are excluded.

The checkout revision is checked before acquisition and again before execution.
Workflow preparation can still intentionally change files in that checkout;
the reported Git revision is not a claim that all working files are unchanged.
The default `all` step, or an explicit `run` step, is the team's execution
authorization. Use a protected GitHub environment when approval is required.

Only the run phase receives model credentials. In default `all` mode, the
`github-token` input defaults to `${{ github.token }}` for both Copilot and
PR reporting. This intentionally shares the combined-permission job token.
Explicit `run` requires `copilot-token` or advanced `credential-env` opt-in
instead of using `github-token`. Installation, version checks and lint are not
passed model tokens, but environment filtering does not isolate processes under
the same runner user. Do not provide any job credentials to untrusted code.

GitHub Actions installation tokens support Copilot when the workflow grants
`copilot-requests: write` and the applicable account policy permits it. The
Action accepts it automatically in `all`, or through an explicit `copilot-token`
override. It masks token inputs, deletes their `INPUT_*` environment variables,
and maps model authentication to `COPILOT_GITHUB_TOKEN` for the run child. It
does not forward `GITHUB_TOKEN` into Vally's SDK user-token option, nor forward
artifact-service tokens, `GH_TOKEN` values or protected process variables.

The simple one-job example grants `contents: read`, `copilot-requests: write`,
and `pull-requests: write`. Eval setup, plugins, and model tools may obtain
this token and use its PR-write permission. This is a documented convenience
trade-off, not proof of isolation. The Action cannot downscope a token.

For stronger separation, use the same Action in independent lint, run, and
report jobs. Grant the run job only contents read and Copilot permission; grant
the report job contents read and PR-write, but no Copilot permission. Explicit
run rejects `report-token`. Reporting downloads and digest-verifies the current
run's structured artifacts and checks repository/revision/run/attempt identity.
It never invokes Vally. Separate jobs reduce evaluator access to PR-write
authority; they are optional, not a platform requirement.

PR comments show the selected suite and native eval names. These fields are
untrusted and Markdown-escaped; do not put secrets in eval or suite names.
Raw paths, prompts, transcripts and model output remain excluded from comments.
Do not assume this credential routing prevents prompt injection in reviewed
evaluation content. Copilot availability and billing depend on the consumer's
account policy and entitlements; synthetic transport tests do not establish
server acceptance.

Vally defaults to npm's latest stable release, or an exact user-selected
version. Acquisition validates registry package integrity, generates a fresh
job-local dependency lock without lifecycle scripts, checks its dependency
origins/integrities, then installs with `npm ci --ignore-scripts`. The recorded
lock, executable, and installed-tree digests are verified on reuse.

There is no Action-maintained version allowlist or reviewed dependency graph.
Latest and transitive dependencies can change between jobs; even an exact CLI
pin does not freeze its upstream dependency ranges. This deliberately trusts
the registry and upstream packages. Runtime CLI/evidence checks detect contract
mismatches, not arbitrary malicious behavior in installed code.

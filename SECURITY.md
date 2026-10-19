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
An explicit run step is the team's execution authorization. Use a protected
GitHub environment when approval is required. No plan-preview approval token
or reusable authorization is invented.

Only run receives `copilot-token` or explicitly named advanced `credential-env`
values. Neither is implicitly inherited. Installation, version checks, plan and
lint receive neither model nor reporting tokens. Reporting credentials are
separate, and protected environment names cannot be forwarded through
`credential-env`. Do not provide secrets to untrusted code. Environment
filtering does not isolate processes under the same runner user.

GitHub Actions installation tokens support Copilot when the workflow grants
`copilot-requests: write` and the applicable account policy permits it. The
Action accepts the workflow token through the explicit `copilot-token` input,
including when the parent has the same `GITHUB_TOKEN` value. It masks the input,
deletes its `INPUT_COPILOT-TOKEN` variable, and maps the value only to
`COPILOT_GITHUB_TOKEN` for the run child. It never forwards `GITHUB_TOKEN`
itself into Vally's SDK user-token option. This narrowly scoped path does not
allow artifact tokens, `GH_TOKEN` values, arbitrary aliases or a token also
supplied as `report-token`.

Do not grant PR-write or other unnecessary repository-write permissions to the
model job. The Action cannot downscope an existing token or prove its permissions.
Keep reporting in a separate job with `contents: read` and
`pull-requests: write`, but no `copilot-requests: write`. That job invokes
`command: report` with the structured artifact ID and digest from the evaluation
job. The report command downloads the current run's artifact itself, verifies its
digest, never runs Vally, and validates repository/revision/run/attempt identity
before writing. A separate verdict job preserves the native outcome.
Do not assume this credential routing prevents prompt injection in reviewed
evaluation content. Live Copilot authentication/billing requires a separately
approved pilot; synthetic transport tests do not establish server acceptance.

The qualified Vally runtime uses a committed, reviewed package lock and `npm ci`.
Pinning only the top-level CLI version is insufficient because its dependency
ranges are mutable. A version without a committed lock is refused before
installation or credentialed execution.

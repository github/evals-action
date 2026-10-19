# Real Copilot smoke example

This example proves that the packaged Action can acquire Vally, authenticate
with the GitHub Actions token, load a real skill, execute one Copilot stimulus,
grade the skill invocation and exact response, and publish structured evidence.

It consumes Copilot AI credits. The repository workflow calls the reusable
workflow with only the example path and suite configured. `command` defaults
to `all`, which lints first and runs the eval only after lint succeeds. Users
can select `command: lint` to avoid model use or `command: run` to skip lint.
The repository workflow limits the run to:

- Same-repository pull requests or manual dispatch.
- One stimulus, with its trial count and 60-second timeout declared in the eval.
- The evaluate job has `contents: read` plus `copilot-requests: write`.
- A separate report job has PR-write permission but no Copilot permission.
- The report job verifies the structured artifact directly; there is no extra
  checkout of the example in the report job or custom verdict script.
- No stored PAT or raw transcript upload.

Organization-owned repositories require the Copilot policy
**Allow use of Copilot CLI billed to the organization**.

The low-level Action remains available for custom jobs:

```yaml
with:
  command: lint
  working-directory: examples/copilot-smoke
```

The real run uses the suite:

```yaml
permissions:
  contents: read
  copilot-requests: write

with:
  command: run
  working-directory: examples/copilot-smoke
  suite: copilot-smoke
  max-retries: 0
  copilot-token: ${{ github.token }}
```

Fork PRs are excluded. For this repository's dedicated control, contributors
who can push same-repository PR branches affecting the Action/example paths are
the approved trust boundary. Protect that capability with repository write
access and branch governance. Environment filtering is not a sandbox.

The reusable workflow updates one sticky PR comment with separate lint and
eval sections. The eval section names `copilot-skill-smoke` and shows the
selected `copilot-smoke` suite. A failed lint posts its status, skips model execution, and
leaves the overall workflow failed. The JavaScript Action's own low-level
`command: lint`, `command: run`, and `command: report` inputs are unchanged.

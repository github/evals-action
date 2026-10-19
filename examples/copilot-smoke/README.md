# Real Copilot smoke example

This example proves that the packaged Action can acquire Vally, authenticate
with the GitHub Actions token, load a real skill, execute one Copilot stimulus,
grade the skill invocation and exact response, and publish structured evidence.

It consumes Copilot AI credits. The repository workflow limits the run to:

- Same-repository pull requests or manual dispatch.
- One stimulus, with its trial count and 60-second timeout declared in the eval.
- The evaluate job has `contents: read` plus `copilot-requests: write`.
- A separate report job has PR-write permission but no Copilot permission.
- No stored PAT or raw transcript upload.

Organization-owned repositories require the Copilot policy
**Allow use of Copilot CLI billed to the organization**.

Lint is model-free:

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

After evaluation, the workflow downloads the Action's structured artifact in a
separate job and invokes the same Action with `command: report`. A final verdict
job restores the native pass/fail status for branch protection.

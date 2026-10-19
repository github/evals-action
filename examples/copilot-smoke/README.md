# Real Copilot smoke example

This example proves that the packaged Action can acquire Vally, authenticate
with the GitHub Actions token, load a real skill, execute one Copilot stimulus,
grade the skill invocation and exact response, and publish structured evidence.

It consumes Copilot AI credits. The repository workflow limits the run to:

- Same-repository pull requests or manual dispatch.
- One stimulus, one trial and one worker.
- Zero retries and a 60-second native timeout.
- `contents: read` plus `copilot-requests: write`.
- No PR-write permission, `report-token`, stored PAT or raw transcript upload.

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
  vally-version: 0.19.0
  runs: 1
  workers: 1
  max-retries: 0
  timeout: 60
  credential-env: COPILOT_GITHUB_TOKEN
env:
  COPILOT_GITHUB_TOKEN: ${{ github.token }}
```

Do not run the credentialed example on fork PRs or unreviewed eval/skill
content. Environment filtering is not a sandbox.

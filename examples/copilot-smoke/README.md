# Real Copilot smoke example

[`copilot-e2e.yml`](../../.github/workflows/copilot-e2e.yml) demonstrates the
consumer's simplest usage: one job, one checkout, and one direct Action call:

```yaml
- uses: ./
  with:
    working-directory: examples/copilot-smoke
    suite: copilot-smoke
```

`command` is omitted. The Action defaults to `all`: validate configuration,
lint, run the real eval after successful lint, and update one sticky PR comment.
Consumers replace `./` with `github/evals-action@v0.1.0` and point
`working-directory` and `suite` at their own evals. See the
[quick start](../../README.md#quick-start) for the full consumer workflow.

The job grants contents read, Copilot access, and PR-comment write permission.
The Action uses `${{ github.token }}` automatically. This combined-permission
token is available to the evaluator; use trusted eval content. Advanced callers
can use explicit `lint`, `run` and `report` commands in separate jobs instead.
The [advanced example](../../README.md#advanced-separate-jobs-and-permissions)
shows the complete isolated layout.

This control consumes Copilot AI credits. It runs one stimulus and one trial,
with a 60-second native timeout from the eval file and zero retries from the
Action's default all mode. It checks real invocation of the `evals-action-smoke`
skill and the exact output `EVALS_ACTION_SKILL_OK`. No stored PAT or raw
transcript upload is needed. Organization-owned repositories require the
**Allow use of Copilot CLI billed to the organization** policy.

Same-repository PRs affecting the Action/example paths and manual dispatch are
supported; forks are excluded. Contributors able to push those same-repository
branches are the approved trust boundary for this repository's live control.
Environment filtering is not a sandbox.

The sticky comment displays suite `copilot-smoke`, native eval
`copilot-skill-smoke`, lint and run outcomes, and links to the structured
evidence. Failed lint skips model execution and still reports the failure;
failed native evals remain failed even if comment publication succeeds.

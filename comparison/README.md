# Trusted PR skill comparisons

`github/evals-action/comparison@<full-commit-SHA>` is a separate, opt-in
`workflow_run` adapter. It does not relax the root Action's event or checkout
policy. It addresses [#26](https://github.com/github/evals-action/issues/26).

Use the [standard two-workflow pattern](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/):
a read-only `pull_request` notifier, followed by a **default-branch**
`workflow_run` workflow with three separately permissioned jobs. Both workflow
files and the trusted selector must exist on the default branch before automatic
activation. Pin all three calls to the same accessible, reviewed Action SHA.
An unmerged Action commit can support a dependent integration PR; that is not
upstream merge, release or production qualification.

## Commands and ownership

| Command | Job permissions | Responsibility |
| --- | --- | --- |
| `context` | `contents: read`, `actions: read`, `pull-requests: read` | Authenticate the exact source workflow/run/attempt, same-repository open PR/head and current merge parents. Emit `context`, local `context-path` and `merge`. No evaluator or candidate code runs. |
| `run` | `contents: read`, `actions: read`, `pull-requests: read`, explicitly approved `copilot-requests: write` | Run one selected skill's Before/After using native Vally, then emit only two bounded verdict projections. |
| `report` | `contents: read`, `actions: read`, `pull-requests: write`; **no billing credential** | On a fresh runner, independently authenticate provenance, read projections as untrusted JSON data and update one bot-owned comment. Never execute candidate code. |

The repository owns changed-skill selection, eval path policy, required
environment-reviewer preflight and protected environment, credential/billing
approval, backend/model configuration, job timeouts, retention, forks and trigger
policy. Skills, evals, graders, fixtures and model experiments stay in the
repository. This Action neither parses their configuration nor implements
native selection, grading or execution. Local saved-result reporting is also
outside this CI adapter.

### Trusted selection job

Call `context` before candidate selection:

```yaml
- uses: github/evals-action/comparison@<full-commit-SHA>
  id: context
  with:
    command: context
    source-workflow: .github/workflows/skill-evals.yml
```

`source-workflow` is the notifier's exact path, not its display name. Context
checks the REST API's producing attempt and workflow path, not artifact claims.
Dotted filenames such as `.github/workflows/skill-evals.pr.yml` are supported;
invalid selectors report an input-specific error. The source run's `head_sha`
must equal the associated, still-current PR head; a branch-matching PR
association alone cannot authenticate a newer revision.
The trusted workflow ref must name the repository's default branch and its
workflow SHA must equal `GITHUB_SHA`. Source cancellation, fork, closed/stale PR,
ambiguous association or invalid merge parents fails closed. Before is the
current verified merge's **first parent**, not potentially stale `PR.base.sha`.
Trusted workflow SHA, candidate merge SHA and selected skill head are distinct.

Check out `steps.context.outputs.merge` with `actions/checkout@v7`,
`fetch-depth: 2` and `persist-credentials: false`. The repository's **trusted**
selector verifies that checkout and reads data without executing candidate
scripts. It performs the repository's environment-protection preflight and
exposes `context`, `selection`, `matrix`, `count` and `attempt` as job outputs.
Map `context` from `steps.context.outputs.context`; the other outputs come
from the repository selector. Use the exact context JSON, including its
authenticated trusted `workflowRef`, as the base of this selection:

```js
const selection = {
  ...context,
  changed: ['writer'],
  skills: [
    { key: 'writer', hasEval: true },
  ],
  include: [{
    key: 'writer',
    id: 'skill-012345abcdef',
    directory: 'capabilities/writer',
    evalPath: 'quality/writer.yaml',
    base: context.base,
    head: context.head,
  }],
};
```

`changed` includes unpaired/new/deleted skills so they remain visibly not run.
`skills` lists the keys/eval availability used to validate selection; it is
not displayed and need contain only selected skills. Existing larger lists
remain compatible. `include` contains only supported existing
Before/After pairs with an eval. Keys and ids must be unique; paths must be
relative, non-traversing and non-symlinked. The eval must be outside the replaced
skill directory. Extra selection fields are rejected. There is no model
override: native saved configuration determines the model.

### Different repository layouts

No `plugins/`, `skills/` or `evals/` directory name is hardcoded. Configure the
checkout root with `working-directory`, and map each changed skill to its
repository-relative `include.directory` and `include.evalPath`, as above.
Put the project's native `.vally.yaml` and normal eval configuration under that
root; Vally owns model/backend/fixture/grader configuration. The trusted caller
determines changed directories and emits the selection; there is no new
Action-specific discovery or configuration format.

Save exactly this JSON as `selection.json`, upload it separately, and retain
the identical JSON in the selection job's `needs` output. An artifact alone
cannot establish context or coverage.

### Protected execution job

The workflow visibly declares the repository's protected `environment`, bounded
matrix and permissions. Paid concurrency must be scoped to the **validated**
PR, head and entry id, for example
`skill-eval-${{ github.repository }}-${{ fromJSON(needs.select.outputs.context).pullNumber }}-${{ fromJSON(needs.select.outputs.context).head }}-${{ matrix.id }}`.
Do not use untrusted top-level notification concurrency to cancel paid work.
Same-head duplicates can cancel; a newer head does not immediately cancel an
old in-flight arm. Current-head checks block its next arm and stale publication.
Cancellation cannot undo billed requests.

```yaml
- uses: actions/checkout@v7
  with:
    ref: ${{ fromJSON(needs.select.outputs.context).merge }}
    fetch-depth: 2
    path: candidate
    persist-credentials: false
- uses: github/evals-action/comparison@<full-commit-SHA>
  id: comparison
  with:
    command: run
    source-workflow: .github/workflows/skill-evals.yml
    context: ${{ needs.select.outputs.context }}
    selection: ${{ needs.select.outputs.selection }}
    producing-attempt: ${{ needs.select.outputs.attempt }}
    comparison-id: ${{ matrix.id }}
    working-directory: candidate
    vally-version: '0.21.0'
    copilot-token: ${{ github.token }}
```

Run supports Linux x64 and exact stable Vally versions only. It restores only
the selected skill from the exact base parent, then head, while holding evals,
graders, fixtures and neighboring skills at the merge revision. Literal Git
arguments, exact HEAD/parent checks and outside-directory/untracked drift checks
prevent accidental measurement substitution. Untracked files include
Git-ignored files: neither arm may consume ignored skill or fixture state left
by an earlier arm. Index `assume-unchanged` and `skip-worktree` flags are
rejected before restoring either arm, rather than trusting a diff that can hide
modified measurement files. It authenticates current context again after approval and
before **each** native arm. Before failure does not
prevent After; cancellation does. One trial, one worker and zero retries are
native CLI overrides, not a second runner. Every arm receives fresh HOME and
TMP/TEMP directories and an allowlisted environment.

`working-directory` must start clean, including no untracked or Git-ignored
files created by earlier setup steps. Do not install dependencies, build
outputs or caches into the candidate checkout before this Action; those files
will prevent either arm from starting. Keep trusted tools and scratch state
outside that checkout.

The Action fingerprints actual checkout bytes, file types, permissions and
symlink targets outside the selected skill before native execution and checks
that baseline before After and immediately after each native arm, before
accepting its projection. A changed baseline makes that arm an error, even if
native grading passed. This preserves legitimate checkout normalization
while detecting byte changes that Git text/EOL normalization can hide.
Regular-file symlinks include both their link text and resolved file bytes and
permissions in the baseline. Directory/special-file symlink targets are
unsupported and fail explicitly.
Initialized/nonempty submodules are unsupported and fail explicitly; an empty
uninitialized gitlink is allowed. Submodule ignore settings must not hide
measurement inputs from the comparison guards.
All Git guards/restores disable replacement objects and force the effective
worktree to the verified candidate directory, ignoring `core.worktree`
redirection. Every Git call also disables hooks and fsmonitor callbacks.
Untracked-file checks
include empty directories, including those inside the selected skill, so
Before-created directory state cannot silently survive into After.
Declared Git filter attributes on tracked files are unsupported and fail before
worktree restoration, including drivers literally named `unset` or `unspecified`
and explicit negative filter declarations. Both working-tree and cached attributes (including local
overrides) are checked for every tracked path before and after staging the
selected source. The original index is preserved through attribute preflight;
index and worktree are then restored together so additions, deletions and
renames remain supported. Ordinary text/EOL normalization is retained; diff guards
disable external diff and text-conversion commands.

Acquisition reuses the root Action's integrity-verified Vally installer:
job-private manifest and generated integrity lock, script-disabled npm restore,
recorded version/CLI/dependency-graph/lock digests. Both arms share **one acquired
graph** and never use candidate manifests or install hooks. This is **not**
equivalent to the starter's committed dependency lock: transitive resolution
can differ across jobs. Engine and lock digests appear in the job summary.

Upload only `steps.comparison.outputs.before-path` and
`steps.comparison.outputs.after-path` with an `if: ${{ !cancelled() }}` upload
step; use a distinct name containing the selection producing attempt and entry
id. Never upload `projection-directory` recursively: it also holds private
native diagnostics. Use SHA-pinned upload/download Actions, seven-day retention
or the repository's tighter policy, and `if-no-files-found: error`.
The run step fails for either native failure/error/not-run/incomplete outcome,
including an otherwise passing native arm with any skipped or ungraded selected
scenario. Every recorded row must be graded; native weighted scoring still
determines the verdict rather than an invented all-graders-pass requirement.
There is no report-only override. Partial paid-job reruns are rejected before
acquisition or model execution: use **Re-run all jobs**.

### Fresh publisher job

Depend on selection and execution with a non-cancellation condition that still
allows reporting failed execution. Serialize publishers by authenticated PR
with `cancel-in-progress: false`. Download only the matching producing-attempt
selection and pair artifacts into a fresh directory, then call:

```yaml
- uses: github/evals-action/comparison@<full-commit-SHA>
  with:
    command: report
    source-workflow: .github/workflows/skill-evals.yml
    context: ${{ needs.select.outputs.context }}
    selection: ${{ needs.select.outputs.selection }}
    producing-attempt: ${{ needs.select.outputs.attempt }}
    artifact-directory: ${{ runner.temp }}/skill-comparison
```

Publisher-only reruns can consume the original selection producing attempt
without repeating models **only while the selected base, head and merge are
still current**. A base-branch advance or regenerated merge invalidates old
projections even if the PR head is unchanged. Use **Re-run all jobs** for fresh
selection and newly approved execution; retrying only the publisher cannot
recover those old paid projections.

Downloaded artifacts must have a **flat** layout: `selection.json` and every
`{id}-before.json` / `{id}-after.json` directly inside `artifact-directory`.
For a pattern download, set `merge-multiple: true`; its default separate
artifact subdirectories are not searched by the publisher.

Exact artifact context, producing attempt and coverage
must match trusted job outputs. Intake accepts bounded regular UTF-8 JSON files,
rejects symlinks/mixed identities/duplicate checks, and discards legacy
failure-reason text. New projections omit reasons entirely. A missing arm is an
error, not a pass. Native declared coverage and individual grader evidence must
be complete before result comparisons are treated as known. Both grader IDs
and configured names must match; a renamed check is an unknown comparison,
not a resolved failure.

The comment shows **only changed skills**, with eval/scenario rows and model
columns containing passing / total **graders** Before → After. There are no
all-skills inventory, delta counters, failure-detail sections or compression
campaigns. The run link provides further evidence. Execution errors, failed
checks, not-run and unknown remain distinct.
Columns are local to each changed skill's recorded models/variants. Recorded
row counts/states remain visible when an arm has errors or incomplete coverage;
the comparison stays unknown and the native verdict is not changed.
Native arm verdicts are displayed separately from evidence completeness and
grader counts. Each projected row also retains its native eval verdict: all
graders passing does not hide a native weighted-score rejection. The optional
`nativeOutcome` arm field and `nativePassed` row field preserve these verdicts;
legacy projections without them have unknown native verdicts, never inferred
passes.
If required results cannot fit the 60,000-byte comment budget, publication fails
explicitly rather than truncating. The budget includes the publisher's marker
and run-order prefix. The Native verdicts line retains the arm-wide outcome.
Scenario annotations use the recorded scenario verdict and checks, not a failing
sibling's eval-group verdict or another model's arm-wide outcome. Native-only
scoring rejection remains visible separately in the verdict header and explicit
`native eval failed` annotations, without marking passing siblings as failures.
Model-less native evidence uses the explicit `Unspecified model` display label;
this is not an inferred model identity.
Missing optional eval names reuse the native parser's normalized group name.
If `selection.json` is missing from the artifact root, publication fails with
`comparison-selection-artifact-missing` and a flat-download layout hint.
The same code covers a missing download directory. Shallow/unavailable checkout
parent lookups use `comparison-checkout-revision-mismatch`; dangling or looping
measurement symlinks use `comparison-unsupported-measurement-symlink`.
Run setup failures distinguish `comparison-working-directory-invalid`,
`comparison-vally-resolution-failed` and `comparison-vally-acquisition-failed`
without exposing raw filesystem, registry or installation exception text.
Authenticated bot author ID (including GitHub App installation bots),
producing-run ordering and a final live PR-head check protect the sticky
comment. Its marker is scoped to the authenticated trusted workflow ref as
well as the source workflow, matching the scope of run numbers. Different
trusted publishers consuming the same notifier do not share comment order.
Workflow-level publisher serialization is still required.
Existing marked reports with missing/malformed ordering tags or non-positive,
unsafe run/attempt numbers are rejected rather than overwritten.
Immediately before writing, the publisher rechecks both the PR head and
selected merge SHA. Like other GitHub API read/write sequences, this is not
an atomic transaction.

## Retained exposure and acceptance limits

Protected approval intentionally permits untrusted candidate eval/setup/grader
code to execute with the billing credential. Environment filtering, fresh arm
state and locked tools are process hygiene, **not** credential/network/shared
kernel isolation or an uneditable organization-wide permission ceiling.
Artifacts are untrusted data, not independent attestations of candidate code.
Prompts, trajectories, model output and raw grader evidence are excluded.
Execution checks reject labels containing the exact execution credential before
writing projections. Projection and publisher intake also reject recognizable
GitHub tokens, bearer/API-key assignments and long mixed alphanumeric token-like
labels, with a fixed safe error and no offending value.
These checks cover check IDs as well as names. Classic GitHub-token prefixes
must start at the label's beginning or a non-alphanumeric boundary and have an
alphanumeric body.
Hyphens and underscores delimit words in the generic length heuristic so
ordinary long skill/scenario names remain valid.
This is defense in depth, not proof against deliberately split/encoded exfiltration by credentialed
candidate code. Names must be suitable for publication; ordinary network and
credential exposure still require the workflow's approval boundary.
Known native/API/reporting error codes are preserved in diagnostics; arbitrary
exception messages remain private. Fixed projection/validation errors also
retain stable `comparison-*` codes, such as `comparison-coverage-mismatch`
and `comparison-comment-too-large`, without untrusted input excerpts.

Bot author ID authenticates the API account, not an exclusive workflow.
Default Actions tokens share `github-actions[bot]`; another permitted
PR-write workflow can forge that bot's marker and ordering text. Do not treat
that shared identity as publisher attestation. A publisher-exclusive GitHub
App token can be supplied through `github-token`, but it must remain unavailable
to candidate workflows; its protected credentials/settings require a separate
repository trust-boundary decision, not an Action input pretending to enforce
organization policy.

Model-free native mock-executor and deterministic-grader tests qualify command
translation and projection. Synthetic GitHub responses qualify provenance,
rerun, stale-head and comment controls. They do **not** establish live token
acceptance, protected-environment configuration, Docker/runtime parity, actual
billing or automatic `workflow_run` end-to-end operation. Those need separately
authorized qualification; no paid run is required for local acceptance.

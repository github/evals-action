# Contributor instructions

- Keep this a thin GitHub adapter over the acquired Vally CLI. Translate
  supported commands and consume native JSONL; never duplicate selection,
  configuration parsing, grading or execution.
- Use Node 24, the pinned pnpm version, and one lockfile. Install with scripts
  disabled. Run focused tests during development and `pnpm check` before review.
- Rebuild and commit `dist` after source changes. Never manually edit bundles.
- Do not run models, add credentials, publish, merge or change repository
  visibility without separate authorization.
- Preserve unknown counts and not-run outcomes. Never infer pass from process
  completion or use a report-only override for native failures.
- Treat prompts, source, raw evidence and credentials as private. Default
  artifacts are allowlisted structured projections only.
- Use argument-array process calls. Use `actions/checkout@v7`; keep other
  third-party Actions SHA-pinned.
- Qualify native behavior with the built-in mock executor and deterministic
  graders. Do not substitute model-backed runs for model-free acceptance.

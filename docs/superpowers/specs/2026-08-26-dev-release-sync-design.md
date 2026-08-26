# Development Branch Parity Design

**Status:** Approved for execution

## Goal

Make `dev` exactly match the current production source branch, `master`, and confirm its automatic development CI/CD deployments succeed without changing production.

## Scope

- Treat `origin/master` at `da78468b9d6a61c956619c3f10017486c70e9492` as the initial source of truth.
- Advance `origin/dev` from `cd7231a645f59bb0021be1390967106aac46f7bb` to that exact commit using a non-forced fast-forward push.
- Repair the Windows development desktop deployment by mapping the existing repository Tauri signing secrets into the `Dev Build` Tauri-build step. Commit that workflow-only change to `master`, then fast-forward `dev` to the same new commit.
- Observe the workflows triggered by the `dev` push through GitHub CLI:
  - `CI`
  - `Deploy Server` targeting `arcane-server-dev`
  - `Deploy Landing` targeting `arcane-landing-dev`
  - `Dev Build` publishing the dev desktop installers
- Confirm the final remote branch SHA and each workflow conclusion.

## Constraints

- Production remains on the existing `v0.3.2` release.
- Do not dispatch `Deploy Server` or `Deploy Landing` with `environment=production`.
- Do not create a release tag, publish a desktop production release, or publish a Unity production package.
- Do not force-push or create a merge commit: `dev` has no commits absent from `master`.
- Validate the workflow-only repair through the resulting GitHub Actions development build; do not add a YAML parsing test.

## Execution Flow

1. Fetch `origin` and verify that `origin/dev` is still an ancestor of `origin/master` and that the working tree has no change that would block the push.
2. Advance the remote development branch with `git push origin origin/master:refs/heads/dev`.
3. Use `gh run list` filtered to the new `dev` commit to obtain the four workflow run IDs.
4. Use `gh run watch` for every run and retrieve failed-job logs with `gh run view --log-failed` if any workflow concludes unsuccessfully.
5. When the Windows `Dev Build` fails because `TAURI_SIGNING_PRIVATE_KEY` is not mapped into the workflow, add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from the existing Actions secrets to its build step, matching `Release`.
6. Commit the workflow-only fix to `master`, fast-forward `dev` to that same commit, and watch the new `CI` and `Dev Build` runs through GitHub CLI.
7. Verify `origin/dev` equals `origin/master` and report the workflow URLs and conclusions. The original promoted SHA's successful `Deploy Server` and `Deploy Landing` runs remain valid because the corrective commit changes only `.github/workflows/dev-build.yml`.

## Failure Handling

- If branch ancestry changes before the push, stop without changing any ref and report the new divergence.
- If any development workflow fails, keep production untouched, retrieve its failed logs, and report the failed job before proposing a fix.
- GitHub workflow dispatch or status polling failures are retried only after confirming the underlying GitHub API request completed or did not create a duplicate run.

## Validation

- `git rev-parse origin/dev` and `git rev-parse origin/master` return the same repair-commit SHA.
- The original promoted SHA's `Deploy Server` and `Deploy Landing` runs conclude with `success`.
- The repair commit's `CI` and `Dev Build` runs conclude with `success`, including the Windows installer upload to the development R2 channel.
- No `workflow_dispatch` production deployment run is created during this operation.

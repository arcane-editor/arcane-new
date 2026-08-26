# Development Branch Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dev` equal the current `master` commit and prove its automatic development CI/CD workflows complete successfully without changing production.

**Architecture:** This is a Git ref promotion, not a source-code change. A non-forced push from `origin/master` to `refs/heads/dev` preserves the linear history and invokes GitHub Actions' `dev` push triggers; GitHub CLI provides the deployment status and failure logs.

**Tech Stack:** Git, GitHub CLI (`gh`), GitHub Actions, Cloudflare Workers, Cloudflare Pages, Cloudflare R2.

**Spec:** `docs/superpowers/specs/2026-08-26-dev-release-sync-design.md`

## Global Constraints

- Production remains on the existing `v0.3.2` release.
- Do not dispatch `Deploy Server` or `Deploy Landing` with `environment=production`.
- Do not create a release tag, publish a desktop production release, or publish a Unity production package.
- Do not force-push or create a merge commit: `dev` has no commits absent from `master`.

---

### Task 1: Verify The Remote Promotion Is Safe

**Files:**
- Modify: remote ref `origin/dev`
- Read: `.github/workflows/ci.yml`
- Read: `.github/workflows/deploy-server.yml`
- Read: `.github/workflows/deploy-landing.yml`
- Read: `.github/workflows/dev-build.yml`

**Interfaces:**
- Consumes: `origin/master` as the release source and `origin/dev` as the development target.
- Produces: a verified source SHA and proof that `origin/dev` is an ancestor of `origin/master`.

- [ ] **Step 1: Refresh remote tracking refs**

Run:

```bash
git fetch --prune origin
```

Expected: the fetch completes successfully.

- [ ] **Step 2: Confirm development has no unique commits**

Run:

```bash
git merge-base --is-ancestor origin/dev origin/master
```

Expected: exit status `0`.

- [ ] **Step 3: Record the refs being promoted**

Run:

```bash
git rev-parse origin/dev && git rev-parse origin/master
```

Expected: the first SHA is `cd7231a645f59bb0021be1390967106aac46f7bb`; the second SHA is `da78468b9d6a61c956619c3f10017486c70e9492`.

- [ ] **Step 4: Confirm the affected development workflows**

Run:

```bash
gh workflow list
```

Expected: active workflows named `CI`, `Deploy Server`, `Deploy Landing`, and `Dev Build`.

### Task 2: Fast-Forward The Development Branch

**Files:**
- Modify: remote ref `origin/dev`

**Interfaces:**
- Consumes: the ancestor proof and source SHA from Task 1.
- Produces: `origin/dev` pointing to the same commit as `origin/master`, which triggers the development workflows.

- [ ] **Step 1: Advance `dev` without force**

Run:

```bash
git push origin origin/master:refs/heads/dev
```

Expected: Git reports a fast-forward update from `cd7231a` to `da78468`; a non-fast-forward update is rejected rather than overwritten.

- [ ] **Step 2: Read back the remote refs**

Run:

```bash
git fetch --prune origin && git rev-parse origin/dev && git rev-parse origin/master && git diff --exit-code origin/dev origin/master
```

Expected: both SHA commands return `da78468b9d6a61c956619c3f10017486c70e9492` and `git diff` has no output with exit status `0`.

### Task 3: Discover And Monitor The Development CI/CD Runs

**Files:**
- Modify: GitHub Actions runs initiated by the `dev` push

**Interfaces:**
- Consumes: the shared `origin/dev` and `origin/master` SHA from Task 2.
- Produces: one completed run per required workflow, with a GitHub URL and final conclusion.

- [ ] **Step 1: Retrieve the workflow runs created for the promoted commit**

Run:

```bash
SHA="$(git rev-parse origin/dev)"
gh run list --branch dev --commit "$SHA" --limit 20 --json databaseId,workflowName,status,conclusion,url
```

Expected: runs for `CI`, `Deploy Server`, `Deploy Landing`, and `Dev Build`, all associated with `da78468b9d6a61c956619c3f10017486c70e9492`.

- [ ] **Step 2: Wait for every required workflow using GitHub CLI**

Run:

```bash
SHA="$(git rev-parse origin/dev)"
workflows=("CI" "Deploy Server" "Deploy Landing" "Dev Build")
pids=()
for workflow in "${workflows[@]}"; do
  run_id=""
  until test -n "$run_id"; do
    run_id="$(gh run list --branch dev --commit "$SHA" --workflow "$workflow" --limit 1 --json databaseId --jq '.[0].databaseId')"
    test -n "$run_id" || sleep 5
  done
  gh run watch "$run_id" --exit-status &
  pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do
  wait "$pid" || status=1
done
exit "$status"
```

Expected: every watcher exits with status `0`. The CI run executes editor type, module-boundary, argument, JavaScript, isolated-process, and Rust tests; the deployment runs publish only development resources.

- [ ] **Step 3: Capture failure logs if any watcher fails**

Run:

```bash
SHA="$(git rev-parse origin/dev)"
gh run list --branch dev --commit "$SHA" --limit 20 --json databaseId,workflowName,conclusion,url --jq '.[] | select(.conclusion != "success") | [.databaseId, .workflowName, .url] | @tsv'
```

Expected: no output. For every output row, run `gh run view <databaseId> --log-failed`, stop, and report that job without retrying a production deployment.

### Task 4: Repair The Development Desktop Signing Configuration

**Files:**
- Modify: `.github/workflows/dev-build.yml:87-92`
- Read: `.github/workflows/release.yml:126-141`

**Interfaces:**
- Consumes: the failed Windows `Dev Build` run `32936464612`, repository Actions secrets named `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the matching working `Release` workflow mapping.
- Produces: a workflow-only commit on `master` that makes both signing secrets available to the Tauri development build and is fast-forwarded unchanged to `dev`.

- [ ] **Step 1: Preserve the failing integration evidence**

Run:

```bash
gh run view 32936464612 --log-failed
```

Expected: the Windows `Build Tauri app (dev config)` step reports that a public key was found but `TAURI_SIGNING_PRIVATE_KEY` was not set.

- [ ] **Step 2: Add the existing signing-secret mappings to Dev Build**

Modify `.github/workflows/dev-build.yml` under the existing `Build Tauri app (dev config)` step's `env` mapping to add:

```yaml
TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

Expected: the mappings match the `Release` workflow's Tauri-build step exactly, while preserving the existing `NODE_OPTIONS`, `VITE_ARCANE_API_URL`, and `VITE_ARCANE_WEB_URL` values.

- [ ] **Step 3: Check the workflow diff before committing**

Run:

```bash
git diff --check && git diff -- .github/workflows/dev-build.yml
```

Expected: no whitespace errors; the only workflow change is the two signing-secret mappings.

- [ ] **Step 4: Commit and publish the workflow-only repair to master**

Run:

```bash
git add .github/workflows/dev-build.yml && git commit -m "fix(ci): pass signing key to dev builds" && git push origin master
```

Expected: one commit containing only `.github/workflows/dev-build.yml` is published to `origin/master`. This push starts `CI` only; it does not dispatch production deployment or release workflows.

- [ ] **Step 5: Fast-forward dev to the repair commit**

Run:

```bash
git push origin origin/master:refs/heads/dev
```

Expected: `dev` advances without force to the new `master` SHA and starts the development `CI` and `Dev Build` workflows. `Deploy Server` and `Deploy Landing` do not rerun because neither their source paths nor their workflow files changed.

### Task 5: Confirm The Development Release State

**Files:**
- Read: remote refs and GitHub Actions run records

**Interfaces:**
- Consumes: successful server and landing deployment records for `da78468b9d6a61c956619c3f10017486c70e9492`, plus successful CI and Dev Build records for the workflow repair commit from Task 4.
- Produces: a release report containing branch parity, workflow conclusions, and workflow URLs.

- [ ] **Step 1: Verify final branch parity**

Run:

```bash
git fetch --prune origin && git rev-parse origin/dev && git rev-parse origin/master && git diff --exit-code origin/dev origin/master
```

Expected: both refs equal the workflow repair commit SHA, and `git diff` exits successfully without output.

- [ ] **Step 2: Verify GitHub Actions conclusions and URLs**

Run:

```bash
SHA="$(git rev-parse origin/dev)"
gh run list --branch dev --commit "$SHA" --limit 20 --json workflowName,conclusion,url --jq '.[] | select(.workflowName == "CI" or .workflowName == "Dev Build") | [.workflowName, .conclusion, .url] | @tsv'
```

Expected: exactly two rows, `CI` and `Dev Build`, each with conclusion `success` and a GitHub Actions URL. The Task 3 report supplies the already-successful `Deploy Server` and `Deploy Landing` URLs for the unchanged application revision.

- [ ] **Step 3: Report the deployment result without changing production**

Report: the shared branch SHA; the repair commit's `CI` and `Dev Build` status and URLs; the original promoted SHA's successful `Deploy Server` and `Deploy Landing` status and URLs; and the Windows installer upload result. State explicitly that no production workflow was dispatched and the `v0.3.2` production release was not changed.

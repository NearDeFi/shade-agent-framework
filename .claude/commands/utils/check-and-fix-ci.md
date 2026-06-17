---
description: Wait for a PR's CI to complete, then diagnose and fix failures until checks pass (max 3 attempts)
disable-model-invocation: true
allowed-tools: Bash(gh repo view:*), Bash(gh pr list:*), Bash(gh pr checks:*), Bash(gh run view:*), Bash(git status:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(cargo fmt:*), Bash(cargo clippy:*), Bash(cargo test:*), Bash(cargo check:*), Read, Edit, Write, Grep, Glob
argument-hint: "<pr-number or url>"
---

# Check and Fix CI

Wait for a PR's CI to finish; if it fails: fix → quality gate → commit → push → re-check, up to 3 attempts. Other commands reference this file as their CI step; it can also run standalone as `/utils:check-and-fix-ci <pr-number>`.

## Inputs

- **PR number**: from `$ARGUMENTS` (bare number or `https://github.com/owner/repo/pull/123` URL). If empty, detect from the current branch: `gh pr list --head $(git branch --show-current) --repo {REPO} --json number --jq '.[0].number'`. If still nothing, stop and ask the user.
- **{REPO}**: `gh repo view --json nameWithOwner --jq .nameWithOwner`
- The PR's branch must be checked out in this working copy — fixes are committed to it.

## Step 1: Detect CI

Wait ~30 seconds for checks to spawn (skip the wait if the PR wasn't just opened), then:

```
gh pr checks {pr-number} --repo {REPO} --json name,status,conclusion
```

If no checks are reported, the repo has no CI for this PR — finish with outcome **NO_CI**.

## Step 2: Poll until completion

Re-check every 30 seconds, up to 10 minutes (do NOT use `--watch` as it can hang indefinitely). If still pending after 10 minutes, report status and ask the user whether to keep waiting.

- All checks pass → finish with outcome **PASS**.
- Any check fails → Step 3.

## Step 3: Fix loop (max 3 attempts)

1. Identify the failing check:
   ```
   gh run view {run_id} --repo {REPO} --log-failed
   ```
   If `--log-failed` shows nothing useful:
   ```
   gh run view {run_id} --repo {REPO} --log | tail -100
   ```
2. Diagnose and fix the failure.
3. Re-run the quality gate: read `.claude/project-specifics/pr-quality-gate.md` and complete all steps.
4. Commit following `.claude/project-specifics/commit-conventions.md` — `fix({scope}): resolve CI failures on PR #{pr-number}` (use the `ci` type instead when the fix is workflow-only). Stage changed files by name (never `git add -A`), then push: `git push origin HEAD`.
5. Go back to Step 2.

After 3 failed attempts, finish with outcome **STILL_FAILING**.

## Outcome

Always end by stating exactly one outcome — the calling command (or the user) decides what happens next:

- **PASS** — all checks green.
- **NO_CI** — no checks run on this PR.
- **STILL_FAILING** — report what's failing and why after 3 fix attempts. Do not keep looping.

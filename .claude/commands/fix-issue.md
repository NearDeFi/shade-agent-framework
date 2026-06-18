---
description: Fix a GitHub issue (by number/URL) or an ad-hoc problem given as free text — create a branch, research the codebase, plan the fix, implement with tests, commit, push, open a PR, wait for CI and fix any failures, then request Claude and Copilot reviews
disable-model-invocation: true
allowed-tools: Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh repo view:*), Bash(gh pr create:*), Bash(gh pr comment:*), Bash(gh pr checks:*), Bash(gh run view:*), Bash(git fetch:*), Bash(git checkout:*), Bash(git status:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(npm ci:*), Bash(npm install:*), Bash(npm i:*), Bash(npm run build:*), Bash(npm run test:*), Bash(npm test:*), Bash(cargo fmt:*), Bash(cargo clippy:*), Bash(cargo test:*), Bash(cargo near:*), Read, Edit, Write, Grep, Glob
argument-hint: "<issue-number, issue-url, or a free-text problem description>"
---

# Fix Issue

## Step 0: Resolve the target repository

This command operates on the repository it is installed in. Resolve the slug from the current clone:

```
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Call it `{REPO}` and use it in every `gh` command below (via `--repo {REPO}`).

- If the command fails (not a git repository, or no GitHub remote), stop and ask the user for the repository.
- All `git` operations (fetch, branch, checkout, commit) run inside this working copy.

## Step 1: Resolve the input

`$ARGUMENTS` is either a GitHub issue reference or a free-text problem description. Decide which:

- **Issue mode** — `$ARGUMENTS` is a bare number (e.g. `42`) or a GitHub issue URL (e.g. `https://github.com/owner/repo/issues/42`). Extract the number and fetch the issue:

  ```
  gh issue view {number} --repo {REPO} --json title,body,labels,assignees,comments,state
  ```

  If the issue is closed, warn the user and ask if they still want to proceed. The issue title + body is the **problem statement**.

- **Ad-hoc mode** — anything else is a free-text problem description (e.g. `there is a problem with xyz, lets fix it`). There is no GitHub issue; the text itself is the **problem statement**. Do not run `gh issue view`. Optionally run `gh issue list --repo {REPO} --search "<keywords>"` to check whether an issue already tracks this — if an obvious match exists, mention it and ask whether to proceed against that issue (Issue mode) instead.

- **Empty** — if `$ARGUMENTS` is blank, stop and ask the user for an issue number or a problem description.

Carry forward the **problem statement** (and, in Issue mode, the issue **number**) — later steps refer to both.

## Step 2: Create a branch

Create a fresh branch off the latest `main` branch. This project integrates PRs on `main` — never branch off another long-lived branch here.

1. Fetch latest: `git fetch origin`
2. Confirm the base branch exists: `git branch -r --list origin/main`. If `origin/main` is not found, stop and tell the user (do not fall back to another branch).
3. Create and switch to a new branch: `git checkout -b fix/{slug} origin/main`
   - **Issue mode:** `{slug}` is `{number}-{short-slug}`, where `{short-slug}` is 3-5 words from the issue title, lowercase, hyphenated (e.g. `fix/42-idor-workspace-check`).
   - **Ad-hoc mode:** `{slug}` is a 3-5 word, lowercase, hyphenated summary of the problem (e.g. `fix/login-redirect-loop`) — no issue number.

If the working tree has uncommitted changes, warn the user and stop. Do not stash or discard their work.

## Step 3: Understand the problem

Summarize the problem in 2-3 sentences. Identify:
- **What's broken or missing** (the symptom or feature request)
- **Acceptance criteria** (what "done" looks like — from the issue body/comments in Issue mode, or inferred from the description in Ad-hoc mode)
- **Constraints** (mentioned technologies, backward compatibility, performance requirements)

If the problem is unclear or ambiguous, list the open questions and ask the user before planning — especially in Ad-hoc mode, where there's no issue body to fall back on, so confirm anything material that the free-text description left undefined.

## Step 4: Research the codebase

Before planning, gather context:

1. **Find relevant code** - Search for files, functions, types, and patterns named in the problem statement. Read them in full.
2. **Trace the flow** - If the problem is about a specific behavior, trace the code path from the entry point (route handler, CLI command, etc.) through to the relevant logic.
3. **Check existing tests** - Find tests related to the affected code. Understand what's already covered.
4. **Check for prior art** - Look for similar patterns in the codebase that solve analogous problems. Prefer consistency with existing patterns.
5. **Load CLAUDE.md guidance** - Find and read the root CLAUDE.md and every CLAUDE.md in directories containing files you expect to touch (use Glob to find them). Their rules are binding on the plan.

## Step 5: Enter planning mode

Enter planning mode to design the implementation. The plan MUST cover:

1. **Root cause** (for bugs) or **design approach** (for features)
2. **Files to modify** with specific descriptions of what changes in each
3. **New files** (if any) with justification for why they're needed
4. **Tests to add** - every code path introduced or changed needs a test:
   - Happy path (expected input produces expected output)
   - Error paths (invalid input, missing data, permission denied)
   - Edge cases (empty collections, boundary values, concurrent access)
5. **Project specific concerns**:
   - Read `.claude/project-specifics/project-specific-concerns.md` and make sure the plan satisfies every project concern and universal rule listed there.
6. **Unsure:** 
   - If you are unsure of anything ask the user

Follow all relevant CLAUDE.md files for architecture decisions: the root CLAUDE.md plus any CLAUDE.md in a directory whose files the plan touches (loaded in Step 4). If a planned change conflicts with one of them, change the plan, not the rule.

Wait for user approval before implementing.

## Step 6: Implement

After the plan is approved:

1. Implement each change from the plan.
2. Write all planned tests.
3. Run project specific quality PR gate:
   - Read `.claude/project-specifics/pr-quality-gate.md` and complete all steps 
4. If any check fails, fix it before proceeding.

## Step 7: Commit, push, and open a PR

1. Commit following `.claude/project-specifics/commit-conventions.md` — read it and pick the type and scope from its lists. In **Issue mode**, reference the issue in the description (e.g. `fix(api): prevent idor in function call outputs (#42)`); in **Ad-hoc mode** there is no issue, so omit the `(#N)` reference.
2. Push the branch: `git push -u origin HEAD` (this pushes only the `fix/{slug}` branch — never push to the integration branch directly).
3. Open a PR into `main` with the summary as its description:

   ```
   gh pr create --repo {REPO} --base main --title "..." --body "..."
   ```

   - **Title**: the commit-conventions format, same type/scope as the commit (e.g. `fix(api): prevent idor in function call outputs`).
   - **Body**: open with — **Issue mode:** `Closes #{number}`; **Ad-hoc mode:** a one-line statement of the problem being fixed (there's no issue to close). Then, in both modes:
     - What changed and why (2-4 sentences, root cause for bugs)
     - Files changed with brief per-file notes
     - Tests added and what they cover
     - A `## Design decisions / Accepted tradeoffs` section if the change makes a deliberate, debatable tradeoff (e.g. a breaking-but-intended choice) — so reviewers treat it as settled rather than re-flagging it each round
     - Any follow-up work, open questions, or coverage a maintainer must run manually (e.g. suites the quality gate is not allowed to run)
     
## Step 8: CI monitor & fix loop

Read `.claude/commands/utils/check-and-fix-ci.md` and follow it for PR #{pr-number}. Act on its outcome:

- **PASS** or **NO_CI** → proceed to Step 9.
- **STILL_FAILING** → stop and report what's failing. Do NOT proceed to Step 9 — never request reviews on a red PR.

## Step 9: Request AI reviews and report

1. Request the Claude review. The Claude workflow triggers on a **comment**, not the PR body or description:

   ```
   gh pr comment {pr-number} --repo {REPO} --body "/claude-review"
   ```

   This fires only if `claude-review.yml` is on the repo's default branch and the authenticated `gh` user is the configured trigger user — if the workflow doesn't start, say so in the recap rather than re-commenting.

2. Request the Copilot review. Copilot is **not** comment-triggered and is **not** auto-requested (there is no Copilot review ruleset), so request it explicitly via the API — the reviewer slug is `copilot-pull-request-reviewer[bot]`, and it reviews the current head:

   ```
   gh api --method POST repos/{REPO}/pulls/{pr-number}/requested_reviewers -f "reviewers[]=copilot-pull-request-reviewer[bot]"
   ```

   This needs the repo/author to have Copilot code-review access and available premium-request quota; if the request errors or Copilot never posts, note it in the recap rather than retrying.

3. Report back in chat: the PR URL, the CI outcome, whether the Claude review comment was posted, whether the Copilot review was requested, and a short recap of the change, tests, and open questions. Remind the user: once the reviews land, continue with `/resolve-pr-reviews {pr-number}` — or run `/auto-resolve-pr {pr-number}` to drive that review→fix loop hands-off to consensus.
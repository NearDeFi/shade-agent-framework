---
description: Fetch a GitHub issue, create a branch, research the codebase, plan the fix, implement with tests, commit, push, open a PR, wait for CI and fix any failures, then request Claude and Copilot reviews
disable-model-invocation: true
allowed-tools: Bash(gh issue view:*), Bash(gh repo view:*), Bash(gh pr create:*), Bash(gh pr comment:*), Bash(gh pr checks:*), Bash(gh run view:*), Bash(git fetch:*), Bash(git checkout:*), Bash(git status:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(npm ci:*), Bash(npm install:*), Bash(npm i:*), Bash(npm run build:*), Bash(npm run test:*), Bash(npm test:*), Bash(cargo fmt:*), Bash(cargo clippy:*), Bash(cargo test:*), Bash(cargo near:*), Read, Edit, Write, Grep, Glob
argument-hint: "<issue-number or github-issue-url>"
---

# Fix GitHub Issue

## Step 0: Resolve the target repository

This command operates on the repository it is installed in. Resolve the slug from the current clone:

```
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Call it `{REPO}` and use it in every `gh` command below (via `--repo {REPO}`).

- If the command fails (not a git repository, or no GitHub remote), stop and ask the user for the repository.
- All `git` operations (fetch, branch, checkout, commit) run inside this working copy.

## Step 1: Resolve the issue

Parse `$ARGUMENTS` to extract the issue number:
- If it's a URL like `https://github.com/owner/repo/issues/42`, extract `42`.
- If it's a bare number, use it directly.
- If empty, stop and ask the user for an issue number.

Fetch the issue:

```
gh issue view {number} --repo {REPO} --json title,body,labels,assignees,comments,state
```

If the issue is closed, warn the user and ask if they still want to proceed.

## Step 2: Create a branch

Create a fresh branch off the latest `main` branch. This project integrates PRs on `main` — never branch off another long-lived branch here.

1. Fetch latest: `git fetch origin`
2. Confirm the base branch exists: `git branch -r --list origin/main`. If `origin/main` is not found, stop and tell the user (do not fall back to another branch).
3. Create and switch to a new branch: `git checkout -b fix/{number}-{short-slug} origin/main`
   - `{short-slug}` is 3-5 words from the issue title, lowercase, hyphenated (e.g. `fix/42-idor-workspace-check`)

If the working tree has uncommitted changes, warn the user and stop. Do not stash or discard their work.

## Step 3: Understand the issue

Summarize the issue in 2-3 sentences. Identify:
- **What's broken or missing** (the symptom or feature request)
- **Acceptance criteria** (what "done" looks like, from the issue body or comments)
- **Constraints** (mentioned technologies, backward compatibility, performance requirements)

If the issue is unclear or ambiguous, list the open questions. These will be addressed during planning.

## Step 4: Research the codebase

Before planning, gather context:

1. **Find relevant code** - Search for files, functions, types, and patterns mentioned in the issue. Read them in full.
2. **Trace the flow** - If the issue is about a specific behavior, trace the code path from the entry point (route handler, CLI command, etc.) through to the relevant logic.
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

1. Commit following `.claude/project-specifics/commit-conventions.md` — read it and pick the type and scope from its lists. Reference the issue in the description (e.g. `fix(api): prevent idor in function call outputs (#42)`).
2. Push the branch: `git push -u origin HEAD` (this pushes only the `fix/{number}-{short-slug}` branch — never push to the integration branch directly).
3. Open a PR into `main` with the summary as its description:

   ```
   gh pr create --repo {REPO} --base main --title "..." --body "..."
   ```

   - **Title**: the commit-conventions format, same type/scope as the commit (e.g. `fix(api): prevent idor in function call outputs`).
   - **Body**: start with `Closes #{number}`, then:
     - What changed and why (2-4 sentences, root cause for bugs)
     - Files changed with brief per-file notes
     - Tests added and what they cover
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

   This fires only if `claude-review.yml` is on the repo's default branch and the authenticated `gh` user is the configured trigger user — if the workflow doesn't start, say so in the recap rather than re-commenting. Copilot review is **not** comment-triggered: if the repo has the Copilot review ruleset, opening the PR already requested Copilot automatically — do not comment for it.

2. Report back in chat: the PR URL, the CI outcome, whether the Claude review comment was posted, whether Copilot was auto-requested (if the ruleset is set up), and a short recap of the change, tests, and open questions. Remind the user: once the reviews land, continue with `/resolve-pr-reviews {pr-number}`.
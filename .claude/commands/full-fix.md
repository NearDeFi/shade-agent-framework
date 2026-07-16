---
description: Fix a GitHub issue (or free-text problem) end-to-end and drive it to AI-review consensus — run /fix-issue to open the PR, then /auto-resolve-pr (loop the review→fix cycle up to 5 passes). For important changes. Never merges.
disable-model-invocation: true
allowed-tools: Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh repo view:*), Bash(gh pr create:*), Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr comment:*), Bash(gh pr checks:*), Bash(gh pr edit:*), Bash(gh pr list:*), Bash(gh pr checkout:*), Bash(gh api:*), Bash(gh run view:*), Bash(git fetch:*), Bash(git checkout:*), Bash(git status:*), Bash(git branch:*), Bash(git worktree:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(git diff:*), Bash(git log:*), Bash(npm ci:*), Bash(npm install:*), Bash(npm i:*), Bash(npm run build:*), Bash(npm run test:*), Bash(npm test:*), Bash(cargo fmt:*), Bash(cargo clippy:*), Bash(cargo test:*), Bash(cargo near:*), Bash(cargo check:*), Read, Edit, Write, Grep, Glob, Agent, Monitor, EnterWorktree, ExitWorktree
argument-hint: "<issue-number, issue-url, or a free-text problem description> [--claude-review and/or --copilot-review, or --all-review (default)] [--max-passes N]"
---

# Full Fix

The **important-changes** end-to-end flow: `/fix-issue` opens the PR, then `/auto-resolve-pr` loops the AI-review→fix cycle to **consensus** (up to 5 passes by default). Use it when the change matters and you want the reviewers driven to agreement, not just one round.

This command **delegates everything** to `/fix-issue` and `/auto-resolve-pr` — it reimplements none of their logic. It **never merges**; merging is a human decision. For quick, low-stakes changes where one review round is enough, use `/quick-fix` instead.

## Phase 0: Resolve repo & parse args

Resolve the target repository from the current clone:

```
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Call it `{REPO}`. If the command fails (not a git repository, or no GitHub remote), stop and ask the user for the repository.

Parse `$ARGUMENTS`:
- **Reviewer flags** — pull any of `--all-review` / `--claude-review` / `--copilot-review` into the **selected reviewer set** (the union — `--all-review` ≡ Claude + Copilot). **If none is given, default to `--all-review`** (this flow requires at least one reviewer, since the resolve loop waits on it).
- **`--max-passes N`** (optional) — pass it straight through to `/auto-resolve-pr` to change the loop cap (default 5). Leave it off for the default.
- **`FIX_INPUT`** — everything left after removing the flags above: the issue number, issue URL, or free-text problem description. If it is empty, stop and ask the user what to fix.

## Phase 1: Fix the issue → open the PR

Read `.claude/commands/fix-issue.md` and execute its **full flow** with arguments `FIX_INPUT` plus the selected reviewer flag(s) (e.g. `123 --all-review`). It will branch into a worktree, plan (pausing for your approval), implement with tests, run the quality gate, commit, push, open the PR, fix CI, and request the selected reviewer(s).

Capture the **PR number** it opens. If `fix-issue` never opens a PR (plan rejected, aborted, or it stops before `gh pr create`), **STOP** and report — do not enter the resolve stage.

## Phase 2: Loop to review consensus

Read `.claude/commands/auto-resolve-pr.md` and execute its **full flow** for the captured PR number with the **same reviewer flag(s)** (plus `--max-passes N` if the user gave one) — e.g. `{pr} --all-review`. It reuses the PR's worktree and loops the wait → `resolve-pr-reviews --fix` → decide cycle until the PR converges (reviewers satisfied + CI green) or hits its cap / a hard stop.

## Phase 3: Report

Relay `auto-resolve-pr`'s final report (PR URL, passes run, commits pushed, CI status, outcome). If the outcome is not `CONVERGED`, name what still blocks it (a reviewer that never landed, a finding it couldn't resolve, or a stuck check) and what the user can do next. Remind them this command **never merges** — the merge decision is theirs once the reviews are satisfied.

## Rules

- **Delegate, don't reimplement.** All planning, fixing, quality-gating, CI repair, review handling, looping, and worktree management live in `fix-issue` and `auto-resolve-pr`. This command only parses args, chains the two, and reports.
- **A reviewer is always in play.** With no reviewer flag it defaults to `--all-review`; the same set is forwarded to both stages.
- **Loops to consensus.** Unlike `/quick-fix`, this runs the full `auto-resolve-pr` loop (up to `--max-passes`, default 5).
- **Never merge.** Merging is a human decision.

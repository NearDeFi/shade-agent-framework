---
description: Fix a GitHub issue (or free-text problem) end-to-end and take it through ONE AI-review→fix round — run /fix-issue to open the PR, then /auto-resolve-pr --max-passes 1 (wait for the reviews + CI, auto-fix once). For quick, low-stakes changes. Never merges.
disable-model-invocation: true
allowed-tools: Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh repo view:*), Bash(gh pr create:*), Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr comment:*), Bash(gh pr checks:*), Bash(gh pr edit:*), Bash(gh pr list:*), Bash(gh pr checkout:*), Bash(gh api:*), Bash(gh run view:*), Bash(git fetch:*), Bash(git checkout:*), Bash(git status:*), Bash(git branch:*), Bash(git worktree:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(git diff:*), Bash(git log:*), Bash(npm ci:*), Bash(npm install:*), Bash(npm i:*), Bash(npm run build:*), Bash(npm run test:*), Bash(npm test:*), Bash(cargo fmt:*), Bash(cargo clippy:*), Bash(cargo test:*), Bash(cargo near:*), Bash(cargo check:*), Read, Edit, Write, Grep, Glob, Agent, Monitor, EnterWorktree, ExitWorktree
argument-hint: "<issue-number, issue-url, or a free-text problem description> [--claude-review and/or --copilot-review, or --all-review (default)]"
---

# Quick Fix

The **low-stakes** end-to-end flow: `/fix-issue` opens the PR, then **one** AI-review→fix round via `/auto-resolve-pr --max-passes 1`. Use it when the change is small and you don't need to grind to full review consensus.

This command **delegates everything** to `/fix-issue` and `/auto-resolve-pr` — it reimplements none of their logic. It **never merges**; merging is a human decision. For important changes that must reach review consensus, use `/full-fix` instead.

## Phase 0: Resolve repo & parse args

Resolve the target repository from the current clone:

```
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Call it `{REPO}`. If the command fails (not a git repository, or no GitHub remote), stop and ask the user for the repository.

Parse `$ARGUMENTS`:
- **Reviewer flags** — pull any of `--all-review` / `--claude-review` / `--copilot-review` into the **selected reviewer set** (the union — `--all-review` ≡ Claude + Copilot). **If none is given, default to `--all-review`** (this flow requires at least one reviewer, since the resolve stage waits on it).
- **`FIX_INPUT`** — everything left after removing the reviewer flags: the issue number, issue URL, or free-text problem description. If it is empty, stop and ask the user what to fix.

## Phase 1: Fix the issue → open the PR

Read `.claude/commands/fix-issue.md` and execute its **full flow** with arguments `FIX_INPUT` plus the selected reviewer flag(s) (e.g. `123 --all-review`). It will branch into a worktree, plan (pausing for your approval), implement with tests, run the quality gate, commit, push, open the PR, fix CI, and request the selected reviewer(s).

Capture the **PR number** it opens. If `fix-issue` never opens a PR (plan rejected, aborted, or it stops before `gh pr create`), **STOP** and report — do not enter the resolve stage.

## Phase 2: One review→fix round

Read `.claude/commands/auto-resolve-pr.md` and execute its **full flow** for the captured PR number with the **same reviewer flag(s)** and **`--max-passes 1`** (e.g. `{pr} --all-review --max-passes 1`). It reuses the PR's worktree, waits (hard-blocking) for the selected reviewer(s) + CI to land on the head, runs `resolve-pr-reviews --fix` once, then stops — a single round, not a grind to consensus.

## Phase 3: Report

Relay `auto-resolve-pr`'s final report (PR URL, passes run, commits pushed, CI status, outcome) and add one line of context: this was the **quick** single-round flow, so the outcome is often `CAP_REACHED` after one pass rather than `CONVERGED` — that's expected. If the change turned out to need more rounds, tell the user to continue with `/auto-resolve-pr {pr} --all-review` (or `/resolve-pr-reviews {pr} --fix --all-review`). Remind them this command **never merges**.

## Rules

- **Delegate, don't reimplement.** All planning, fixing, quality-gating, CI repair, review handling, and worktree management live in `fix-issue` and `auto-resolve-pr`. This command only parses args, chains the two, and reports.
- **A reviewer is always in play.** With no reviewer flag it defaults to `--all-review`; the same set is forwarded to both stages.
- **One round only.** The `--max-passes 1` cap is what makes this the *quick* flow — it does not loop to consensus.
- **Never merge.** Merging is a human decision.

---
description: Interactively review every git worktree under .claude/worktrees/ — for each, show its branch, why it was created, any related PR (state + CI), commits and unpushed/uncommitted work, then give a keep/delete recommendation with a reason and ask before removing. Never deletes without confirmation; never silently skips or auto-deletes a worktree that has uncommitted or unpushed work.
disable-model-invocation: true
allowed-tools: Bash(git worktree:*), Bash(git -C:*), Bash(git branch:*), Bash(git fetch:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh repo view:*), Read, AskUserQuestion
---

# Cleanup Worktrees

Review and prune the git worktrees under `.claude/worktrees/` (created by `/fix-issue` and `/resolve-pr-reviews`). This inspects **every** worktree — including ones that have only uncommitted changes and no commits — shows what's on each, and asks you keep-or-delete per worktree with a recommendation. It never deletes anything without your confirmation, and never discards uncommitted or unpushed work without a second, explicit confirmation.

## Phase 0: Resolve repo

```
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Call it `{REPO}`. If it fails (not a git repository, or no GitHub remote), stop and ask the user for the repository.

## Phase 1: Enumerate worktrees

```
git fetch origin --prune
git worktree list --porcelain
```

Parse the porcelain output into (path, branch/detached) pairs. **Only** consider worktrees whose path is under `.claude/worktrees/`; ignore the main checkout and any worktree elsewhere on disk. If none remain, say "No worktrees under `.claude/worktrees/` to review." and stop.

## Phase 2: Gather context per worktree

For each `.claude/worktrees/<name>` on branch `<branch>`, gather read-only with `git -C .claude/worktrees/<name> …`:

- **Why it was created** — infer from `<branch>`:
  - `fix/*` → a fix started by `/fix-issue`; the slug describes the issue or problem.
  - dir named `pr-<n>` → resolving PR #`<n>` via `/resolve-pr-reviews`.
  - otherwise → report the branch name; origin unknown.
- **Related PR** — `gh pr list --head <branch> --repo {REPO} --state all --json number,title,state,url,mergedAt --jq '.[0]'`. Record number, title, and state (OPEN / MERGED / CLOSED). For an OPEN PR, also summarise CI with `gh pr checks <n> --repo {REPO}`. No match → "no PR".
- **Commits (work done)** — `git -C … log --oneline origin/main..HEAD`: the count and subjects of commits on this branch beyond `main`.
- **Unpushed** — if the branch has an upstream (`git -C … rev-parse --abbrev-ref @{u}` succeeds), `git -C … log --oneline @{u}..HEAD` are the unpushed commits. No upstream but commits beyond `main` → treat all of them as unpushed.
- **Uncommitted changes** — `git -C … status --porcelain`: count of modified + untracked files. Surface this prominently — a worktree with uncommitted changes is **never** a silent skip and **never** a safe auto-delete.

## Phase 3: Recommend per worktree (first match wins)

- **Uncommitted changes present** → **Keep** — "N uncommitted file(s); deleting loses that work."
- **Unpushed commits present** → **Keep** — "N commit(s) not on the remote; deleting loses them."
- **PR OPEN** → **Keep** — "PR #<n> is open; you'll still iterate on it (reviews / CI)."
- **PR MERGED** → **Delete** — "PR #<n> merged; the branch is upstreamed, nothing local to lose."
- **PR CLOSED (unmerged)** → **Delete** — "PR #<n> closed without merging; work abandoned."
- **No PR, no commits beyond `main`, clean** → **Delete** — "empty scaffold; no work on it."
- **No PR but has (pushed) commits** → **Keep** — "has commits but no PR yet; likely work in progress."

## Phase 4: Present, then ask per worktree

First print one summary table:

```
## Worktrees under .claude/worktrees/  (N)

| Worktree | Branch | Why | PR | Commits | Unpushed | Uncommitted | Recommend |
|----------|--------|-----|----|---------|----------|-------------|-----------|
```

Then ask keep-or-delete for **each** worktree with `AskUserQuestion` (batch up to 4 per call). For every question: make the recommended action the first option, labelled `… (Recommended)`, and put the one-line reason from Phase 3 in its description. Name the worktree, branch, and PR in the question text so it is unambiguous which one is being decided.

## Phase 5: Act on the answers

Run from the main checkout — never `EnterWorktree` these; inspect and remove them in place.

For each worktree the user chose to **delete**:

1. **Re-check safety immediately before removing.** If it has uncommitted changes or unpushed commits, do **not** delete on the earlier answer alone — confirm once more, naming exactly what would be lost (the file count / the commit subjects). Proceed only on explicit confirmation to discard.
2. Remove it:
   ```
   git worktree remove .claude/worktrees/<name>
   ```
   If it refuses over the safety guard and the user confirmed discard: `git worktree remove --force .claude/worktrees/<name>`.
3. Delete the local branch when it's merged or the user confirmed discard: `git branch -D <branch>` (skip for a detached head).

Leave every **keep** worktree completely untouched.

## Phase 6: Report

Summarise: which worktrees were removed, which were kept and why, and call out any kept specifically because they held uncommitted or unpushed work. Give the remaining worktree count.

## Rules

- **Never delete without an explicit per-worktree confirmation.**
- **Never discard uncommitted or unpushed work** without a second confirmation naming what would be lost.
- **Read-only until the user has chosen** — no checkout, reset, or stash in any worktree.
- **Never touch the main checkout** or any worktree outside `.claude/worktrees/`.

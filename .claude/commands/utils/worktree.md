# Worktree setup & teardown

Shared procedure for running a command inside an isolated git worktree under `.claude/worktrees/`, so multiple sessions (one terminal each) can work in parallel without colliding on a branch or the working tree. `.claude/worktrees/` is gitignored — these worktrees are never tracked.

Worktrees are created with `git worktree add` (for an exact branch name) and the session is moved into them with `EnterWorktree` (`path:`), so every Read / Edit / Bash runs against the worktree. Reaping merged/closed worktrees is the job of `/cleanup-worktrees`; an individual command only removes a worktree it created when its own run **aborts before committing anything**.

## Enter — new branch (a fresh fix off `main`)

Inputs: `{slug}` (worktree directory name) and `{branch}` (e.g. `fix/{slug}`).

1. `git fetch origin`
2. If `.claude/worktrees/{slug}` already appears in `git worktree list`, it exists — skip to step 4.
3. Create it off the latest base branch:
   ```
   git worktree add .claude/worktrees/{slug} -b {branch} origin/main
   ```
   `git worktree add -b` fails if `{branch}` already exists; the calling command's collision rule picks a distinct slug before this point.
4. Move the session in: `EnterWorktree` with `path: .claude/worktrees/{slug}`.
5. Confirm `git branch --show-current` is `{branch}` and `pwd` ends in `.claude/worktrees/{slug}`.

Because the fix runs in a dedicated worktree branched off `origin/main`, the main checkout is untouched — no need to stash or worry about its state.

## Enter — existing PR branch (resolving a PR)

Inputs: `{number}` (PR number) and `{REPO}`.

**Reuse first.** A branch can only be checked out in one worktree at a time, so the goal is to land in the worktree the PR's branch is *already* in — normally the one `/fix-issue` created for this same branch. Only create a new worktree when nothing has that branch checked out.

1. Find the PR's head branch: `gh pr view {number} --repo {REPO} --json headRefName --jq .headRefName` → `{branch}`.
2. `git fetch origin`
3. **Reuse if it exists.** Look in `git worktree list --porcelain` for an entry with `branch refs/heads/{branch}`. If found, `EnterWorktree` with `path:` that worktree and stop (a no-op if the session is already there). This is the common case — continuing the work `/fix-issue` started, and the idempotent re-entry on later `/auto-resolve-pr` passes.
4. **Otherwise create one** (no worktree has `{branch}`: e.g. resolving a PR this machine never worked on, or whose worktree was already reaped). Create a detached worktree, enter it, then let `gh` check out the PR head (this handles fork PRs and names the branch correctly):
   ```
   git worktree add --detach .claude/worktrees/pr-{number} origin/main
   ```
   `EnterWorktree` with `path: .claude/worktrees/pr-{number}`, then:
   ```
   gh pr checkout {number} --repo {REPO}
   ```

## Safety rules (before any removal)

A worktree is **safe to remove** only when both hold — check while still inside it, or with `git -C .claude/worktrees/{name} …`:

- **No uncommitted changes:** `git status --porcelain` is empty.
- **No unpushed commits:** the branch has an upstream and `git log @{u}..HEAD` is empty. A branch with no upstream but commits beyond `origin/main` counts as unpushed → not safe.

Never remove a worktree that fails either check unless the user has explicitly chosen to discard that specific work.

## Teardown — aborted run

If a command aborts **before making any commit** (plan rejected, early error), remove the empty worktree it just created so dead-ends don't accumulate:

1. While still inside it, confirm nothing was committed: `git log --oneline origin/main..HEAD` is empty and `git status --porcelain` shows only scaffold, if anything.
2. `ExitWorktree` (`action: keep`) to return the session to the main checkout.
3. `git worktree remove .claude/worktrees/{name}` (add `--force` only if it refuses over untracked scaffold and you've confirmed nothing was committed).
4. Delete the abandoned branch if one was created: `git branch -D {branch}`.

## Teardown — successful run

Do **not** remove the worktree at the end of a successful run — the PR is open and review rounds still need the branch locally. Leave it in place and report its path. `/cleanup-worktrees` reaps it once its PR is merged or closed.

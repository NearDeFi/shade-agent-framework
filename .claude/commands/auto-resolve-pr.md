---
description: Loop the PR review→fix cycle to consensus — kick off the reviews if none are pending, wait for Claude+Copilot & CI, run resolve-pr-reviews (--fix), repeat up to 5×; never merges
disable-model-invocation: true
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr comment:*), Bash(gh pr checks:*), Bash(gh pr edit:*), Bash(gh pr list:*), Bash(gh pr checkout:*), Bash(gh api:*), Bash(gh repo view:*), Bash(gh run view:*), Bash(git diff:*), Bash(git log:*), Bash(git fetch:*), Bash(git checkout:*), Bash(git status:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(npm ci:*), Bash(npm install:*), Bash(npm i:*), Bash(npm run build:*), Bash(npm test:*), Bash(npm run test:*), Bash(cargo fmt:*), Bash(cargo clippy:*), Bash(cargo test:*), Bash(cargo check:*), Read, Edit, Write, Grep, Glob, Agent
argument-hint: "<pr-number or url>"
---

# Auto-Resolve PR

Drive `/resolve-pr-reviews` to consensus in a capped loop: **wait** for the Claude + Copilot reviews and CI to land on the current head (kicking the reviews off only if nothing is already pending), run `resolve-pr-reviews` fully autonomously (`--fix`), then repeat — at most **5 passes** — until the PR converges or hits a hard stop.

`resolve-pr-reviews` already does one full pass (classify → fix → quality-gate → push → fix CI → re-request both reviewers) and **stops** when the AI reviews are missing or stale, telling a human to trigger the reviewers and re-run. This command is that human-in-the-loop. It owns **waiting + looping**, and triggers reviews only to fill the gap `resolve-pr-reviews` leaves: at **cold start**, when no review or request exists yet, so the first delegated pass doesn't immediately stop. After any pass that pushes a fix, `resolve-pr-reviews` itself re-requests both reviewers — so on later passes this command only **waits** on those pending requests, it does not re-trigger. It delegates **all classification, fixing, replying, and CI repair** to `resolve-pr-reviews` and reimplements none of it.

**This command never merges. Merging is a human decision.**

## Phase 0: Resolve repo & parse args

Resolve the target repository from the current clone:

```
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Call it `{REPO}` and use it in every `gh` command below. If the command fails (not a git repository, or no GitHub remote), stop and ask the user for the repository.

Parse `$ARGUMENTS` for the PR number:
- Extract from a bare number or a `https://github.com/owner/repo/pull/123` URL.
- If absent, detect from the current branch: `gh pr list --head $(git branch --show-current) --repo {REPO} --json number --jq '.[0].number'`
- If still nothing, stop and ask the user.

Set `MAX_PASSES = 5`. Track `total_commits_pushed = 0` and a per-pass log for the final report.

---

## Phase 1: Convergence loop

Repeat for `pass = 1 .. MAX_PASSES`. Announce the pass number at the start of each iteration.

### Step A — Snapshot the head

```
gh pr view {number} --repo {REPO} --json headRefOid,commits
```

Record `headRefOid` (call it `head_before`) and the last commit's `committedDate`. These define "current head" for the freshness checks in Step B and for detecting whether this pass pushed anything in Step D.

### Step B — Ensure both reviews are fresh + CI complete (the wait)

A review counts only if it was posted **after** `committedDate` (same freshness rule as `resolve-pr-reviews`). A review of an earlier commit is **stale** — treat it as missing.

- **Claude reviewed** ⇔ an issue comment by `github-actions[bot]` matching the claude-review output contract (contains `### Code review`, `Found N issues`, or `No issues found.`) that is newer than the head commit.
- **Copilot reviewed** ⇔ a review in `pulls/{number}/reviews` by `copilot-pull-request-reviewer[bot]` newer than the head commit.

Gather state:
```
gh api --paginate repos/{REPO}/issues/{number}/comments
gh api --paginate repos/{REPO}/pulls/{number}/reviews
gh pr view {number} --repo {REPO} --json reviewRequests
gh pr checks {number} --repo {REPO} --json name,status,conclusion
```

For **each** reviewer, decide what to do — **trigger only if neither a fresh review nor a pending request exists**. Mostly this fires only at cold start (pass 1): after any pass that pushed a fix, `resolve-pr-reviews` has already re-requested both reviewers, so this command finds them pending and just waits — it does not re-trigger.

| State of this reviewer | Action |
|---|---|
| Fresh review present (newer than head) | Done — nothing to do |
| Request already pending (Copilot in `reviewRequests`, or a `/claude-review` comment newer than head) | Don't trigger — just wait (already requested) |
| Neither (cold start) | Trigger it (below), then wait |

Triggers (only for the "neither" case):
```
gh pr comment {number} --repo {REPO} --body "/claude-review"
gh api --method POST repos/{REPO}/pulls/{number}/requested_reviewers -f "reviewers[]=copilot-pull-request-reviewer[bot]"
```
If the Claude workflow doesn't start (it fires only when `claude-review.yml` is on the default branch and the authenticated `gh` user is the configured trigger user), note it and **STOP** — don't spin. If the Copilot request errors (no Copilot access / quota), note it and **STOP**.

**Poll until ready.** Repeat, with ~30s between iterations (do **not** use `gh ... --watch` — it can hang; wait with a backgrounded `sleep 30` re-check or the `Monitor` tool), until **both reviews are fresh AND CI is non-pending**, or **~15 minutes** have elapsed:

1. Re-run the four queries above.
2. Both reviews fresh (postdate the head commit) **AND** no CI check still `queued`/`in_progress` → exit the loop and go to Step C. (CI may be red — `resolve-pr-reviews` repairs that next.)
3. Otherwise wait ~30s and repeat.

On the 15-minute timeout, report which reviewer or check never landed and **STOP** with outcome `REVIEW_TIMEOUT`. Claude's review is the slow path (opus, xhigh, 4 parallel agents), so expect it to take several minutes.

### Step C — Delegate one pass to resolve-pr-reviews

Read `.claude/commands/resolve-pr-reviews.md` and execute its full flow for PR #{number} **with the `--fix` flag** (fully autonomous — never block on the findings table). It will address comments, run the quality gate, push, run the CI fix loop, and at the end either post `Reviews passed!` (clean path) or re-request both reviewers (if it pushed commits).

### Step D — Decide (machine-checkable, not from prose)

Re-read the head and recount the unresolved comments + CI:
```
gh pr view {number} --repo {REPO} --json headRefOid
gh api --paginate repos/{REPO}/pulls/{number}/comments
gh pr checks {number} --repo {REPO} --json name,status,conclusion
```
Let `head_after` be the new `headRefOid`. If `head_after != head_before`, increment `total_commits_pushed` by the number of new commits.

Classify the pass:

- **Converged** ⇔ `head_after == head_before` **AND** CI green **AND** zero unresolved review comments **AND** both reviews fresh. This is exactly the `resolve-pr-reviews` clean path (it posted `Reviews passed!`). → **STOP — success.**
- **Progress** ⇔ `head_after != head_before` (the pass pushed fixes; `resolve-pr-reviews` already re-requested both reviewers against the new head). → loop back to **Step A**. Step B will see the pending requests and just wait for the fresh reviews.
- **Stall** ⇔ `head_after == head_before` **but not converged** (e.g. a finding it classified as a false positive that a reviewer keeps reopening, or something it couldn't fix). Re-running would reproduce an identical state. → **STOP — report.** This is also the infinite-loop guard.
- **Hard stop** ⇔ `resolve-pr-reviews` stopped unrecoverably (CI `STILL_FAILING` after its 3 attempts, a finding it couldn't classify or fix, or a review trigger that never fired). → **STOP — report.**

---

## Phase 2: Cap

If `MAX_PASSES` passes complete without convergence, **STOP**. Never start a 6th pass.

---

## Phase 3: Final report

Report honestly — do not claim consensus unless the final pass actually converged:

```
PR #{number}: {title}
Passes run: {N}/5
Commits pushed: {total_commits_pushed}
CI: {PASS|FAIL|PENDING}
Outcome: {CONVERGED | REVIEW_TIMEOUT | STILL_FAILING | STALL | CAP_REACHED}
```

In prose: per-pass summary (what each pass fixed / pushed), the final CI status, whether consensus was reached (`Reviews passed!` posted on the final clean pass) or which reviewer / finding / check still blocks it, and the stop reason if it didn't converge. Remind the user that this command **never merges** — that decision belongs to a human.

---

## Rules

- **Never merge.** This command does not merge PRs under any circumstances.
- **Hard cap of 5 passes.** Never exceed it.
- **Delegate, don't reimplement.** Only trigger, wait, and decide here. All classification, fixing, replying, and CI repair lives in `resolve-pr-reviews` — run it via `--fix`.
- **Same freshness rule as `resolve-pr-reviews`.** A review counts only if it postdates the current head commit; stale reviews are treated as missing.
- **Trigger only at cold start.** Kick off a review only when neither a fresh review nor a pending request exists. After a fix-pushing pass, `resolve-pr-reviews` has already re-requested both — just wait; never double-request across the handoff.
- **Stop on stall and on hard failure.** Don't waste passes re-running an unchanged, unconverged state.
- **No `--watch`; poll every ~30s** (backgrounded `sleep 30` re-check or the `Monitor` tool) with a ~15-minute timeout on the wait step.

---
description: Check that both AI reviewers have reviewed a PR, resolve their comments, keep CI green, and re-request review — never merges
disable-model-invocation: true
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr comment:*), Bash(gh pr checks:*), Bash(gh pr edit:*), Bash(gh pr list:*), Bash(gh pr checkout:*), Bash(gh api:*), Bash(gh repo view:*), Bash(gh run view:*), Bash(git diff:*), Bash(git log:*), Bash(git fetch:*), Bash(git checkout:*), Bash(git status:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(cargo fmt:*), Bash(cargo clippy:*), Bash(cargo test:*), Bash(cargo check:*), Read, Edit, Write, Grep, Glob, Agent
argument-hint: "<pr-number or url> [--fix]"
---

# Resolve PR Reviews

Review-gate → classify comments → fix → quality gate → push → CI → re-request reviews, or post "Reviews passed!" when there is nothing left to resolve.

**This command never merges. Merging is a human decision.**

## Phase 0: Resolve the target repository

This command operates on the repository it is installed in. Resolve the slug from the current clone:

```
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Call it `{REPO}` and use it in every `gh` command below (via `--repo {REPO}`, and as the path segment in `gh api repos/{REPO}/...` calls).

- If the command fails (not a git repository, or no GitHub remote), stop and ask the user for the repository.
- All `git` operations (fetch, checkout, commit, push) and `gh pr checkout` run inside this working copy.

## Parse arguments

Parse `$ARGUMENTS`:
- Extract PR number from bare number or `https://github.com/owner/repo/pull/123` URL.
- Flags: `--fix` (auto-fix without asking).
- If no PR number, detect from current branch: `gh pr list --head $(git branch --show-current) --repo {REPO} --json number --jq '.[0].number'`
- If still nothing, stop and ask the user.

---

## Phase 1: Situational Awareness

Gather everything in parallel. Every `gh` command targets `{REPO}` resolved in Phase 0.

**PR metadata:**
```
gh pr view {number} --repo {REPO} --json number,title,body,author,baseRefName,headRefName,headRefOid,state,isDraft,files,additions,deletions,labels,reviewRequests
```

**Diff:**
```
gh pr diff {number} --repo {REPO}
gh pr diff {number} --repo {REPO} --name-only
```

**CI status:**
```
gh pr checks {number} --repo {REPO} --json name,status,conclusion,detailsUrl
```

**Review comments and reviews:**
```
gh api --paginate repos/{REPO}/pulls/{number}/comments
gh api --paginate repos/{REPO}/pulls/{number}/reviews
```

**Issue comments** (the Claude review lands here — it is an issue comment, not a review comment):
```
gh api --paginate repos/{REPO}/issues/{number}/comments
```

Save `headRefOid` — needed for posting line comments and the duplicate-comment guard later.

**Review-gate detection** — determine which AI reviewers have reviewed:

- **Claude reviewed** ⇔ an issue comment authored by `github-actions[bot]` matching the claude-review output contract: contains `### Code review`, `Found N issues`, or `No issues found.`
- **Copilot reviewed** ⇔ a review in `pulls/{number}/reviews` authored by `copilot-pull-request-reviewer[bot]` (displays as "Copilot").

A review only counts if it was posted **after** the current head commit (compare its `created_at`/`submitted_at` against `gh pr view {number} --repo {REPO} --json commits --jq '.commits[-1].committedDate'`). A review of an earlier commit is **stale** — the code changed since that reviewer looked — and is treated as missing.

**Assess the situation and print a status card:**

```
PR #{number}: {title}
Author: {author}    Base: {base} ← {head}
Size: +{additions} -{deletions} across {file_count} files
CI: {PASS|FAIL|PENDING|NONE}
AI reviews: Claude {✓|✗|stale}    Copilot {✓|✗|stale}
Reviews: {N approved, N changes_requested, N comments-only, N bot-only}
Unresolved comments: {N}
Draft: {yes|no}
```

**Decide the mode:**

1. **Claude or Copilot review missing or stale** → STOP. Tell the user which reviewer is missing and how to trigger it: Claude — comment `/claude-review` on the PR; Copilot — it reviews automatically on PR open and on each push via the repo's ruleset, so push a commit (or re-request it from the PR's Reviewers panel) if its review is missing or stale. Then re-run this command. Do not proceed.
2. **Unresolved review comments exist** → Phase 2 (address them).
3. **CI failing, no unresolved comments** → Phase 6 (jump to CI fix).
4. **Both reviewed + CI passing + nothing unresolved** (no comments needing action, or all already resolved) → Phase 7 (clean path).

---

## Phase 2: Address Review Comments

For each unresolved review comment or review with CHANGES_REQUESTED — this covers Claude's findings inside its consolidated issue comment, Copilot's inline review comments, and human comments alike:

1. **Read the referenced code** at the file and line mentioned. Never assess without reading.
2. **Classify each comment:**
   - ✅ **Valid & unresolved** — needs a code fix
   - ✅ **Already fixed** — a later commit addressed it
   - ❌ **False positive** — explain why the code is correct
   - 🔧 **Nit** — optional improvement, not blocking

3. **Deduplicate** — bots (Claude, Copilot, Gemini) and humans often post the same finding. Group by actual issue.

Present a table:

| # | Source | File:Line | Issue | Status | Planned Fix |
|---|--------|-----------|-------|--------|-------------|

Wait for user confirmation (unless `--fix` flag set), then proceed to Phase 3.

---

## Phase 3: Fix

Checkout the PR branch if not already on it (handles fork PRs automatically):
```
gh pr checkout {number} --repo {REPO}
```

**Implement fixes** for the approved review-comment fixes (from Phase 2).

Follow project specific concerns:
   - Read `.claude/project-specifics/project-specific-concerns.md` and make sure the fixes satisfy every project concern and universal rule listed there.

After all fixes implemented, proceed to Phase 4.

---

## Phase 4: Quality Gate

- Read `.claude/project-specifics/pr-quality-gate.md` and complete all steps 

**If any step fails:** fix the issue and re-run. Do NOT proceed past a failing step. Loop up to 3 times per step. If still failing after 3 attempts, report the failure and stop.

---

## Phase 5: Commit & Push

Stage changed files by name (never `git add -A` — it can include unintended files):
```bash
git add path/to/changed/file1 path/to/changed/file2
git commit -m "{message}"
```

Commit message format — read `.claude/project-specifics/commit-conventions.md` first and pick the type and scope from its lists:
- For review fixes: `fix({scope}): address review findings on PR #{number}`
- For comment responses: `fix({scope}): address review comments on PR #{number}`
- For CI fixes: `fix({scope}): resolve CI failures on PR #{number}` (use the `ci` type instead — `ci: resolve ...` — when the fix is workflow-only)
- Include specifics in the body (which findings/comments were addressed)

Push:
```bash
git push origin {headRefName}
```

**Reply to addressed review comments on GitHub.** For each comment that was fixed, reply with the commit SHA and a brief description of what was done. For false positives, reply explaining why no change was needed.

---

## Phase 6: CI Monitor & Fix Loop

Read `.claude/commands/utils/check-and-fix-ci.md` and follow it for PR #{number}. Act on its outcome:

- **PASS** or **NO_CI** → proceed to Phase 7.
- **STILL_FAILING** → report what's failing and why, then stop. Don't keep looping.

---

## Phase 7: Outcome

Two paths with different end states — report each honestly. Do not print a success card claiming the AI reviewers are satisfied unless their reviews actually cover the current head commit.

**If this run pushed any commits** (review fixes from Phase 5 and/or CI fixes from Phase 6): the fixes are new code the reviewers have not seen — their earlier reviews are now stale, and whether they are happy with the result is unknown. The push already triggered Copilot's re-review (its ruleset reviews new pushes), so only Claude needs a comment:

```
gh pr comment {number} --repo {REPO} --body "/claude-review"
```

Then report:

```
PR #{number}: {title}
CI: ✅ PASS (on the new head)
Findings fixed: {N}    Comments addressed: {N}    Commits added: {N}
```

In prose, list which comments were addressed and what was pushed, note that Claude was re-requested and Copilot re-reviews the push automatically, and remind the user to re-run `/resolve-pr-reviews` after the new reviews land. Do **NOT** post "Reviews passed!" on this path.

**If this run started clean** (mode 4 — both reviewed the current head, CI passing, nothing to resolve, no commits pushed): post exactly one comment:

```
gh pr comment {number} --repo {REPO} --body "Reviews passed!"
```

Duplicate guard: if a "Reviews passed!" comment already exists and is newer than the current head commit, report that instead of posting again. Then report:

```
PR #{number}: {title}
CI: ✅ PASS
AI reviews: Claude ✓    Copilot ✓ (both reviewed the current head; nothing unresolved)
Ready for a human to merge.
```

---

## Rules

- **Read before judging.** Never classify a finding or reply to a comment without reading the referenced code in full. Verify line numbers.
- **Be specific in replies.** "Fixed in `abc123` — now returns 400 because X" or "False positive: the null check on line 38 already guards this" — not "addressed!" or "this might be fine."
- **Fix the pattern, not just the instance.** When fixing a bug, grep for the same pattern across the repo.
- **Don't over-fix.** Only change what was flagged. Don't refactor surrounding code or add improvements beyond the review scope.
- **Credit original authors.** If taking over someone else's PR, credit them in commits and comments.
- **No secrets in comments.** Never include customer data, credentials, or PII in GitHub comments.
- **Distinguish certainty when classifying.** "This IS a false positive because X" vs "this COULD be a false positive" — be honest about which you have, and say so in the reply.
- **When uncertain, fix it.** If you can't establish whether a finding is valid or a false positive, classify it as valid and fix it — dismissing a real bug as a false positive is the expensive mistake.
- **Parallel where possible.** Use Agent tool for parallel file reads on large PRs. Batch `gh api` calls.
- **Never merge.** This command does not merge PRs under any circumstances — that decision belongs to a human.

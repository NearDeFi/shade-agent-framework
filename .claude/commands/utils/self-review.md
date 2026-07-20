# Pre-push self-review

Shared, **blocking** procedure: review your own diff against the same bar the CI reviewer applies, *before* pushing — so the PR lands with the findings already fixed instead of surfacing them a round later. A caller (`/fix-issue`, `/resolve-pr-reviews`) runs this after its quality gate and before commit/push. It is a gate: you may not push while any must-fix finding is unfixed. (A finding that turns out to be a deliberate tradeoff, not a defect, is recorded rather than fixed — recording never substitutes for fixing a real must-fix; see step 4.)

This is not the quality gate (build/test/lint) — that still runs separately. This is the *judgement* pass the automated gate can't do.

## Why

The CI Claude review (`.github/workflows/claude-review.yml`) reviews every PR with four independent agents against a fixed severity rubric. Almost everything it flags is knowable before the PR exists. Running the same review locally, first, is the main lever for landing PRs the reviewers have little to add to.

## Procedure

### 1. Scope the diff

This gate runs **before** the commit, so the change is usually still in the working tree. Review the full set your branch introduces relative to `main` — committed *and* uncommitted:

```bash
git status --porcelain              # staged, unstaged, and untracked files
git diff HEAD                        # uncommitted edits (the common case on /fix-issue)
git diff origin/main...HEAD          # anything already committed on the branch (e.g. earlier /resolve-pr-reviews passes)
```

Map the changed files to areas (same top-level-directory mapping as `.claude/project-specifics/pr-quality-gate.md`). Read the full source of each changed file, not just the hunks — a finding usually lives in the code *around* the change.

### 2. Review against the CI reviewer's rubric

**Read `.github/workflows/claude-review.yml`** and use its four review dimensions and its exact **severity (CRITICAL / HIGH / MEDIUM / LOW) and confidence (0–100)** rubric as the bar — it is the single source of truth, so don't restate or fork it here. In summary the dimensions are:

1. **Security & Safety** — TEE attestation/measurement verification never weakened or bypassed; contract owner-gating intact; only authorized payloads signed; no leaked keys/secrets; untrusted input validated; no Rust `unwrap`/`expect`/`panic!` on attacker-influenced input.
2. **Architecture & Patterns** — cross-package sync rules (docs/reference, example templates, `tests-in-tee/`); published-API discipline; example-deployment-files still valid; consistency with existing patterns; NEAR storage/serialization safety.
3. **Bug Scan** — logic errors, off-by-one, missing error handling, wrong return values.
4. **Performance & Production** — on-chain gas/compute; error handling + retries on network/RPC/Phala/deploy calls; sensible timeouts; no needless clones in hot attestation paths; resource cleanup.

Review as an adversary trying to *find* problems in your own diff, not to confirm it is fine. For a large or multi-package diff, dispatch these dimensions as parallel subagents (Agent tool) — each reads the diff and the changed source itself and returns findings scored `[SEVERITY:CONFIDENCE]`; for a small single-area diff one focused pass is enough.

### 3. Add the two checks the diff alone won't surface

- **Adversarial tests.** For every untrusted input the change touches, confirm a test attacks it (per the trust-boundary checklist in `.claude/project-specifics/project-specific-concerns.md`). Missing hostile-input coverage on an untrusted boundary is a must-fix, not a nit — it is exactly what the reviewer's Security agent flags.
- **Interactions with untouched code.** Bugs are usually not diff-local. Check the code the diff does *not* change but depends on: parallel paths handling the same condition, shared state/storage, and the callers and callees of every changed function. A break here is the most expensive kind the reviewer catches.

### 4. Resolve every finding, then gate

Classify each finding and act:

- **CRITICAL / HIGH / actionable MEDIUM** → **fix before pushing.** These are the findings the reviewer will otherwise raise.
- **Deliberate tradeoff** (a real but intentional choice) → do not "fix" it; **record it in the PR's `## Design decisions / Accepted tradeoffs` section** (one line, the decision and why). The `claude-review` prompt reads that section and will not re-raise a listed item — this is what keeps a decision settled instead of re-litigated each round. (On `/fix-issue` the PR doesn't exist yet — carry these lines into the PR body when it's created.)
- **LOW / nit** → fix if cheap; otherwise leave it.

**Gate:** do not proceed to commit/push while any must-fix finding (a CRITICAL/HIGH/actionable-MEDIUM defect) is unfixed. Recording does **not** clear a must-fix — it applies only to the deliberate-tradeoff category above, which by definition is not a defect. If a finding needs a call you can't make, stop and ask rather than pushing past it.

Re-run the affected part of the quality gate after any fix this pass introduced (a self-review fix is new code).

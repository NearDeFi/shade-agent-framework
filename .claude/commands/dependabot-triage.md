---
description: Read-only triage of open Dependabot PRs — classify each (ecosystem, grouped, patch/minor/major, dev/runtime, security, CI status), print a CLI table with a suggested action, then give concrete per-PR guidance for anything non-routine (CI-failure diagnosis, what to read in the changelog, exact local verification commands). Never merges, closes, comments, or edits.
disable-model-invocation: true
allowed-tools: Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh run view:*), Bash(gh api:*), Bash(gh repo view:*), Read, Grep, Glob
argument-hint: "[ecosystem filter: npm|cargo|github-actions|docker] (optional)"
---

# Dependabot triage

Classify every open Dependabot PR in this repo, print one table with a **suggested action** per PR, then give **enhanced, concrete guidance for every non-routine PR** (CI failures, majors, measurement-sensitive bumps, deploy/attestation-path deps, stale leftovers). This command is **read-only** — it never merges, closes, comments, approves, or edits. It produces a triage a human acts on.

Optional `$ARGUMENTS`: if it names an ecosystem (`npm`, `cargo`, `github-actions`, `docker`), only show that ecosystem; otherwise show all.

## Phase 0 — Resolve repo

```
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Call it `{REPO}`. If it fails, stop and ask the user for the repo.

## Phase 1 — Gather

```
gh pr list --repo {REPO} --author "app/dependabot" --state open --limit 100 \
  --json number,title,labels,headRefName,createdAt,url,statusCheckRollup
```

Read PR bodies where the title isn't enough to enumerate grouped deps/versions: `gh pr view <n> --repo {REPO} --json title,body`. If there are zero open Dependabot PRs, say so and stop.

## Phase 2 — Classify each PR

- **Ecosystem** — from `headRefName`: `dependabot/npm_and_yarn/…`→**npm**, `…/cargo/…`→**cargo**, `…/github_actions/…`→**github-actions**, `…/docker/…`→**docker**.
- **Grouped?** — **grouped** if the title names a group ("the patch group", "in the minor group", "… across 1 directory"); else **individual**.
- **Bump type** — patch / minor / major. Grouped → the group name. Individual → parse `from A.B.C to D.E.F`. **0.x flag**: `0.A.x → 0.B.x` is breaking-risk; mark and treat as major.
- **Scope** — **dev** if title is `chore(deps-dev)…`; else **runtime** (may be mixed).
- **Security?** — `security` label or a GHSA-/CVE- advisory block in the body.
- **CI** — ✅ / ❌ / ⏳ / – from `statusCheckRollup`.
- **Repo flags**:
  - `⛔ measurements` — docker base image (e.g. `node`): changing it moves the reproducible-build hash → approved measurements must be re-approved; attestation/registration can break.
  - `🧪 e2e-gap` — deploy/attestation path (`@phala/cloud`; anything under `shade-attestation` / `shade-contract-template`; the contract). `ci-passed` (build + unit tests) does **not** exercise these.
  - `🧹 superseded?` — an *individual* npm/cargo **patch/minor** (non-major) PR is likely a pre-grouping leftover now covered by a group PR; verify before closing.

Context for the actions: this repo runs a **merge queue on `main`** gating on `ci-passed` (use "Merge when ready"), and a **10-day cooldown + `min-release-age=7`**, so supply-chain-freshness risk is already handled — focus on *behavioral* breakage. The **`/run-e2e`** suite (real Phala TEE + deploy) **is runnable on Dependabot PRs**: a maintainer comments `/run-e2e` on the PR — it runs on `main`- and `stable`-base PRs, uses repo secrets (Dependabot branches are in-repo, not forks), and is **non-blocking** (not a required check, so it never gates the merge queue — you read its result). That's the way to cover the `🧪`/`⛔` gaps `ci-passed` skips; the alternative is running `tests-in-tee` locally.

## Phase 3 — For every CI ❌ PR, diagnose the failure (don't just report it)

Find the failing job and read its log:

```
gh pr checks <n> --repo {REPO}
gh run view <run-id> --repo {REPO} --log-failed
```

Then state, per failing PR: *which job failed → the actual error → likely cause → how to resolve.* Common failures here:
- **`dependency_file_not_resolvable` / npm `ERESOLVE` / peer-dep error** → a peer/version conflict from the bump, or an `.npmrc` issue (e.g. a malformed `min-release-age`). Remedy: name the conflicting packages; suggest grouping them so they bump together, an `ignore` entry, or fixing `.npmrc`.
- **`tsc` build error in `shade-agent-template`** → a breaking type change in `shade-agent-js` or a bumped type dep. Remedy: point at the offending symbol — a real breaking change to handle, not a flake.
- **`cargo` clippy/test failure** → an API change in the bumped crate; name the failing test/lint.
- **Lockfile out of sync / `npm ci` mismatch** → regenerate the lockfile.
- **Flake / infra** (network, runner) → re-run the job; not a real failure.

## Phase 4 — Suggested action (first match wins)

1. **CI ❌** → `❌ Don't merge — see diagnosis below`
2. **CI ⏳** → `⏳ Wait for CI`
3. **security = yes** (CI ✅) → `🔴 Merge ASAP (security fix)` — but if also `⛔ measurements`, it still needs `/run-e2e` + measurement re-approval first (rule 4).
4. **`⛔ measurements`** → `⛔ Don't routine-merge — needs measurement re-approval; /run-e2e on the PR first`
5. **`🧹 superseded?`** → `🧹 Close (superseded by group) — verify first`
6. **major** (incl. 0.x) → `🟠 Review migration; merge with the change or @dependabot ignore this major version`
7. **minor group / minor** (CI ✅) → `🟡 Skim changelog, then merge`
8. **patch group / patch**, or any **dev-scope** group (CI ✅) → `✅ Safe to merge`

Append `· 🧪 /run-e2e to cover deploy path` to the action for any `🧪 e2e-gap` PR.

## Phase 5 — Output

### Table
One markdown table, sorted safest-first:

```
## Dependabot triage — {REPO}  (N open)

| PR | Eco | Package(s) | Grouped | Bump | Scope | CI | Sec | Suggested action |
|----|-----|------------|---------|------|-------|----|----|------------------|
```
Keep package lists short ("headline +N more"). Nothing before the table but a one-line header.

### Enhanced guidance (only for non-routine PRs — skip pure `✅ Safe to merge`)
For each CI-❌, major, `⛔`, `🧪`, security, or `🧹` PR, a short block:

> **#N — `<pkg>` <bump>**
> - **Why flagged**: one line.
> - **What to check**: for CI ❌ → the Phase 3 diagnosis (job → error → cause → fix). For changelog cases → *what to read*: open the PR body's release notes and scan for **Breaking Changes / Removed / Deprecated / changed defaults / new peer or engine (Node, MSRV) requirements**, plus the dep-specific risk (e.g. asn1.js→DER/ASN.1 parsing, commander→arg parsing, @phala/cloud→deploy API surface).
> - **Verify locally / via e2e** (runtime/major/`🧪`/`⛔`): the ecosystem recipe below, and/or comment `/run-e2e` on the PR for deploy/attestation coverage.
> - **Decision**: merge / close / `@dependabot ignore this major version` / `/run-e2e` + measurement re-approval.

### Local verification recipes (include the ones relevant to flagged PRs)
- **shade-agent-cli dep**: `gh pr checkout <n> --repo {REPO}` → `cd shade-agent-cli && npm ci && npm run build && npm test` → smoke: `node dist/src/cli.js --help` (+ a deploy dry-run for commander/inquirer changes).
- **shade-agent-js dep**: `cd shade-agent-js && npm ci && npm run build && npm test`, then build the consumer: `cd ../shade-agent-template && npm ci && npm run build`.
- **cargo (shade-attestation / shade-contract-template)**: `cargo fmt --check && cargo clippy --all-targets && cargo test` — for the contract run the **full** `cargo test` (the sandbox integration tests CI skips with `--lib`).
- **docker base image / deploy-path** (`⛔`/`🧪`): unit CI is insufficient. Cover it by commenting **`/run-e2e`** on the PR (maintainer; non-blocking), or run `cd tests-in-tee && npm ci && npm run test` locally (needs `PHALA_API_KEY` + funded testnet NEAR; see root README). A docker base-image bump also needs **measurement re-approval**.

### Summary
- Counts by action bucket.
- **Merge order**: safe patch/dev groups → minor groups (after a skim) → majors one at a time → `⛔`/`🧪` after `/run-e2e` (or local e2e) + any measurement re-approval.
- Flags legend — only for flags that appeared.

Then **stop**. Take no action — the human decides what to merge/close.

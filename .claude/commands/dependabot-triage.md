---
description: Read-only triage of open Dependabot PRs — classify each (ecosystem, grouped, patch/minor/major, dev/runtime, security, CI, plus human/claude[bot] comment signal), print a CLI table with a suggested action (a maintainer's stated decision overrides), then give concrete per-PR guidance for anything non-routine (CI-failure diagnosis, what to read in the changelog, and the exact local commands from checkout for any hands-on check). Pass --md to write the triage to dependabot-triage-result.md at the repo root. Never merges, closes, comments, or edits.
disable-model-invocation: true
allowed-tools: Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh run view:*), Bash(gh api:*), Bash(gh repo view:*), Read, Grep, Glob, Write
argument-hint: "[ecosystem: npm|cargo|github-actions|docker] [--md] (both optional)"
---

# Dependabot triage

Classify every open Dependabot PR in this repo, print one table with a **suggested action** per PR, then give **enhanced, concrete guidance for every non-routine PR** (CI failures, majors, measurement-sensitive bumps, stale leftovers) — and for each major bump say whether CI covers it, it needs **`tests-in-tee`**, or it needs a **hands-on local run** of a specific package/path. This command is **read-only** — it never merges, closes, comments, approves, or edits. It produces a triage a human acts on.

Optional `$ARGUMENTS` (space-separated, order-independent):
- An **ecosystem** name (`npm`, `cargo`, `github-actions`, `docker`) → only show that ecosystem; otherwise show all.
- **`--md`** → instead of printing the triage to the terminal, write it to a file at the repo root (see Phase 5). The triage is identical either way; `--md` only changes where it goes.

"Read-only" refers to GitHub state — the command never merges, closes, comments, approves, or edits PRs. With `--md` the **only** thing it writes is that one local result file.

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

Also read each PR's **conversation** — human comments carry decisions the triage must respect (e.g. "blocked till we upgrade rust", "ignoring this major", "merge after X"):

```
gh pr view <n> --repo {REPO} --json comments,reviews
```

Two kinds of signal matter:
- **Human comments / reviews** — especially the maintainer's or PR author's own (e.g. `PiVortex`). A stated human decision **overrides** the computed action (Phase 4) — quote it.
- **`claude[bot]` review comments** — the repo's Claude Code review action posts as **`claude[bot]`**; that is the bot to read for review findings. **Ignore `github-actions[bot]`** output (CI/workflow noise, not review signal). Treat `claude[bot]` findings as input, not gospel.

Fetch this for every flagged PR (and any you're unsure about); skip it for pure `✅ Safe to merge` patch/dev groups.

## Phase 2 — Classify each PR

- **Ecosystem** — from `headRefName`: `dependabot/npm_and_yarn/…`→**npm**, `…/cargo/…`→**cargo**, `…/github_actions/…`→**github-actions**, `…/docker/…`→**docker**.
- **Grouped?** — **grouped** if the title names a group ("the patch group", "in the minor group", "… across 1 directory"); else **individual**.
- **Bump type** — patch / minor / major. Individual → parse `from A.B.C to D.E.F`. Grouped → the group name (patch / minor).
  - **0.x rule (dominates the group name):** for a pre-1.0 dep, a `0.A.x → 0.B.x` bump (the minor/`y` position moves) is breaking-risk — **classify it as `major`**, not minor. A pre-1.0 `0.A.x → 0.A.z` (only the patch/`z` moves) stays **patch**.
  - This escalation applies **inside a group**: if a `patch`/`minor` group contains any dep doing a `0.y` bump, the group's effective bump is **`major`** — label the Bump cell `major (0.x)`, name the offending dep, and take the major action (Phase 4 rule 6), not the minor/patch one. (e.g. a "minor group" containing `@phala/cloud 0.2.9 → 0.3.0` → **major**.)
- **Scope** — **dev** if the title is `chore(deps-dev)…`, else **runtime** (this repo's Dependabot titles do carry the `chore(deps)` / `chore(deps-dev)` prefix). If a title ever lacks it, fall back to the manifest at the PR head — npm: bumped packages in `devDependencies` vs `dependencies` — and label **mixed** when a group spans both.
- **Security?** — `security` label or a GHSA-/CVE- advisory block in the body.
- **CI** — ✅ / ❌ / ⏳ / – from `statusCheckRollup`.
- **Comments / human signal** — from the conversation (Phase 1): any human comment stating a decision (blocked / hold / ignore / merge-after-X), attributed to its author and quoted; plus any `claude[bot]` review findings (not `github-actions[bot]`). These feed the **human override** in Phase 4 and the **Decision** line in Phase 5.
- **Repo flags** (drive the action + the verification tier in Phase 5):
  - `⛔ measurements` — docker base image (e.g. `node`): changing it moves the reproducible-build hash → approved measurements must be re-approved; attestation/registration can break.
  - `🧪 tests-in-tee` — a surface CI runs only as *mocked* unit tests but `tests-in-tee` exercises for real: `@phala/dstack-sdk` (shade-agent-js TEE path), `@phala/cloud` (CLI deploy path), `near-sdk` / anything under `shade-contract-template` (on-chain behaviour — CI runs `cargo test --lib`, skipping the sandbox integration tests), `dcap-qvl` / `dstack-sdk-types` / anything under `shade-attestation` (real quote/collateral verification — CI tests fixtures only).
  - `🔧 manual` — a surface covered by **neither** CI nor `tests-in-tee`, so a **major** bump needs a hands-on local run — where a pre-1.0 `0.y` bump counts as major (the 0.x flag) (Phase 5 table): `commander` (CLI arg parsing — `cli.js` is never driven by a test), `@napi-rs/keyring` (`shade-agent-cli/src/utils/keystore.js` — untested; e2e uses its own NEAR keys), `@inquirer/*` (CLI prompts — mocked in CI, never prompted in e2e), or any **shade-agent-template** runtime dep (`ethers`, `chainsig.js`, `hono`, `@hono/node-server`, `cors` — the template has no tests, CI runs only `tsc`, and e2e deploys `test-image/`, not the template).
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

**Human override (beats every rule below).** If a maintainer / PR-author comment states a decision — *blocked*, *hold*, *ignore*, *will-merge-after-X* — adopt it as the action, attributed and quoted, e.g. `⛔ Held by @PiVortex: "Blocked till we upgrade rust past 1.86 in the contract builder"`. Still show the mechanical action too, but lead with the human decision. `claude[bot]` findings inform but don't override.

1. **CI ❌** → `❌ Don't merge — see diagnosis below`
2. **CI ⏳** → `⏳ Wait for CI`
3. **security = yes** (CI ✅) → `🔴 Merge ASAP (security fix)` — but if also `⛔ measurements`, it still needs `/run-e2e` + measurement re-approval first (rule 4).
4. **`⛔ measurements`** → `⛔ Don't routine-merge — needs measurement re-approval; /run-e2e on the PR first`
5. **`🧹 superseded?`** → `🧹 Close (superseded by group) — verify first`
6. **major** (incl. a pre-1.0 `0.y` bump, and any group escalated to major by the 0.x rule in Phase 2) → `🟠 Review migration; merge with the change or @dependabot ignore this major version`
7. **minor group / minor** (CI ✅) → `🟡 Skim changelog, then merge`
8. **patch group / patch**, or any **dev-scope** group (CI ✅) → `✅ Safe to merge`

Append `· 🧪 run tests-in-tee (/run-e2e)` for any **major** `🧪 tests-in-tee` PR, and `· 🔧 manual run first` for any **major** `🔧 manual` PR. **Major here includes a pre-1.0 `0.y` bump** (`0.A.x → 0.B.x`, the 0.x flag); a patch or a `≥1.0` minor does **not** get a run recommendation — CI covers it, trust `ci-passed`. (`⛔ measurements` is exempt: it always needs `/run-e2e` + re-approval — see rule 4.)

## Phase 5 — Output

**Destination.** Build the full triage (table + enhanced guidance + coverage tiers + summary) exactly as specified below, then:
- **Default (no `--md`)** → print it to the terminal.
- **`--md` present** → write the complete triage to `{repo-root}/dependabot-triage-result.md` with `Write` (resolve the repo root with `git rev-parse --show-toplevel`). `Write` overwrites, so a previous `dependabot-triage-result.md` there is replaced. Start the file with the `## Dependabot triage — {REPO}  (N open)` header and a one-line "generated read-only on {today}" note; don't print the body to the terminal — just confirm the path written and give a one-line headline (e.g. counts by bucket).

### Table
One markdown table, sorted safest-first:

```
## Dependabot triage — {REPO}  (N open)

| PR | Eco | Package(s) | Grouped | Bump | Scope | CI | Sec | Suggested action |
|----|-----|------------|---------|------|-------|----|----|------------------|
```
Keep package lists short ("headline +N more"). Nothing before the table but a one-line header.

### Enhanced guidance (only for non-routine PRs — skip pure `✅ Safe to merge`)
For each CI-❌, major, `⛔`, security, `🧹`, or any **major** `🧪`/`🔧` PR (a pre-1.0 `0.y` bump counts as major), a short block — a patch or `≥1.0` minor `🧪`/`🔧` PR is routine, skip it:

> **#N — `<pkg>` <bump>**
> - **Why flagged**: one line — include any human / `claude[bot]` comment signal (quote a human decision).
> - **What to check**: for CI ❌ → the Phase 3 diagnosis (job → error → cause → fix). For changelog cases → *what to read*: open the PR body's release notes and scan for **Breaking Changes / Removed / Deprecated / changed defaults / new peer or engine (Node, MSRV) requirements**, plus the dep-specific risk (e.g. asn1.js→DER/ASN.1 parsing, commander→arg parsing, @phala/cloud→deploy API surface).
> - **Verify** by coverage tier (Phase 5): for **major** bumps (incl. a pre-1.0 `0.y` bump), `🧪` → `tests-in-tee` (`/run-e2e`) and `🔧` → the manual check for that package/path; `⛔` always needs `/run-e2e` + measurement re-approval regardless of bump; a **patch or `≥1.0` minor** `🧪`/`🔧` bump and anything CI already covers → trust it, no local re-run.
> - **Run it (exact commands)** — *required for any `🔧 manual` PR; include it whenever you're routing the reader to a hands-on check.* Spell out the literal sequence **from getting the branch locally**, tailored to the package — don't make the reader guess:
>   - **always start**: `gh pr checkout <n> --repo {REPO}` → `cd <package-dir>` → `npm ci` (Rust: `cargo build`).
>   - **shade-agent-cli → say what *settings/commands* to run**: the exact subcommand + flags/config/env to set. e.g. `commander` → `node src/cli.js --help` then the subcommand whose options changed, with its flags, checking parse + exit code; `@napi-rs/keyring` → a full auth round-trip `node src/cli.js auth login` (store) → a read-back command → `auth logout` (delete), confirming the OS-keychain entry appears and is removed; `@inquirer/*` → run a command that actually prompts (`auth login`, a destructive-redeploy confirm, `whitelist`) and answer each prompt.
>   - **shade-agent-template → say what *actions* to take**: `npm run dev`, then the path to exercise. e.g. `ethers`/`chainsig.js` → drive the chain-signature / EVM flow end-to-end; `hono`/`@hono/node-server`/`cors` → `curl` the agent's routes and confirm responses + CORS headers.
> - **Decision**: merge / close / `@dependabot ignore this major version` / `/run-e2e` + measurement re-approval — **and honor any human comment** (e.g. maintainer said "blocked till rust > 1.86" → the decision is *hold*, regardless of CI).

### Verification by coverage tier (only for flagged PRs)
`ci-passed` runs per-package **build + mocked unit tests on ubuntu**. Treat anything it covers as done — an ubuntu pass stands in for other platforms, so never ask for a local re-run of what CI already runs. Route only the gaps:

**🧪 Run `tests-in-tee` (real Phala TEE + chain + deploy).** Flag these **only for major bumps** (incl. a pre-1.0 `0.y` bump) — `ci-passed` only mocks them, so a breaking change needs real-TEE coverage; a patch or `≥1.0` minor is covered, trust CI. Comment **`/run-e2e`** on the PR (maintainer; non-blocking; `main`/`stable` base, in-repo secrets), or run it locally — **build `shade-agent-js` first** (`cd shade-agent-js && npm ci && npm run build`; the test image copies its gitignored `dist/`), build the contract WASM, then `cd tests-in-tee && npm ci && (cd test-image && npm ci) && npm run test` (needs a funded testnet NEAR account + `PHALA_API_KEY`; full recipe in `tests-in-tee/README.md`).

| Dep / change | Why only tests-in-tee covers it |
|---|---|
| `@phala/dstack-sdk` (shade-agent-js) | real CVM quote + key derivation (`tee.ts` is mocked in CI) |
| `@phala/cloud` (shade-agent-cli) | `tests-in-tee` runs the real `phala-deploy.js` deploy (CI mocks the SDK) |
| `near-sdk` / `shade-contract-template/**` | on-chain register / owner-gating / upgrade — CI runs `cargo test --lib`, skipping the sandbox integration tests |
| `dcap-qvl` / `dstack-sdk-types` / `shade-attestation/**` | verification against live collateral (CI's `cargo test` uses fixtures) |
| docker base image (`node`) `⛔` | new image → new measurement; **also re-approve measurements** |

**🔧 Run it by hand (covered by NEITHER CI nor tests-in-tee).** A **major** bump here (incl. a pre-1.0 `0.y` bump) has no automated gate; a patch or `≥1.0` minor is covered — trust CI. `gh pr checkout <n> --repo {REPO}` first.

| Package · location | Trigger dep | Run it — from `gh pr checkout <n> --repo {REPO}` (CLI: what *settings* to run · template: what *actions* to take) |
|---|---|---|
| `shade-agent-cli/src/cli.js` — arg parsing | `commander` | `cd shade-agent-cli && npm ci && node src/cli.js --help`, then run the subcommand whose options changed with its flags; confirm parsing + exit codes |
| `shade-agent-cli/src/utils/keystore.js` + `src/commands/auth/*` — OS keychain | `@napi-rs/keyring` | `cd shade-agent-cli && npm ci`, then a full auth round-trip: `node src/cli.js auth login` (store) → a read-back command → `auth logout` (delete); confirm the OS-keychain entry is created then removed |
| `shade-agent-cli` prompts — `src/commands/auth/prompts.js`, `src/utils/destructive-redeploy.js`, `src/utils/error-handler.js`, `src/commands/whitelist/index.js` | `@inquirer/*` | `cd shade-agent-cli && npm ci`, then run a command that prompts (`auth login`, a destructive-redeploy confirm, `whitelist`) and answer each prompt; confirm input/confirm/select all render and submit |
| `shade-agent-template/**` — whole app (no tests; CI = `tsc` only; e2e deploys `test-image/`, not this) | `ethers`, `chainsig.js` | `cd shade-agent-template && npm ci && npm run dev`, then drive the chain-signature / EVM path end-to-end |
| `shade-agent-template` — web layer | `hono`, `@hono/node-server`, `cors` | `cd shade-agent-template && npm ci && npm run dev`, then `curl` the agent's routes and confirm responses + CORS headers |

### Summary
- Counts by action bucket.
- **Merge order**: safe patch/dev groups → minor groups (after a skim) → majors one at a time → `🔧` majors after a manual run → `⛔`/`🧪` majors after `tests-in-tee` + any measurement re-approval.
- Flags legend — only for flags that appeared.

Then **stop**. Take no action — the human decides what to merge/close.

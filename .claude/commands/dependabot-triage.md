---
description: Read-only Dependabot triage with two scans, both on by default — (A) open Dependabot PRs: classify each (ecosystem, grouped, patch/minor/major, dev/runtime, security, CI, plus human/claude[bot] signal) and suggest an action; (B) open security alerts (vulnerabilities): dedupe across manifests and bucket each by fix-availability + direct-vs-transitive + whether Dependabot watches its manifest, with the exact command to clear it — plus a local npm audit + cargo audit cross-check across every manifest to surface anything Dependabot missed. Toggle with --no-prs / --no-vulns (default runs both); --md writes the result to dependabot-triage-result.md. Never merges, closes, comments, edits, approves, dismisses, or runs any audit-fix.
disable-model-invocation: true
allowed-tools: Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh run view:*), Bash(gh api:*), Bash(gh repo view:*), Bash(npm audit:*), Bash(cargo audit:*), Bash(git rev-parse:*), Read, Grep, Glob, Write
argument-hint: "[ecosystem: npm|cargo|github-actions|docker] [--no-prs] [--no-vulns] [--md] (all optional)"
---

# Dependabot triage

Two read-only scans of this repo's Dependabot state, **both run by default**:

- **Scan A — open Dependabot PRs** (Phases 1–5): classify every open Dependabot PR, print one table with a **suggested action** each, then give concrete guidance for non-routine PRs (CI failures, majors, measurement-sensitive bumps, stale leftovers) and the coverage tier (CI / `tests-in-tee` / hands-on local run) for each major.
- **Scan B — open security alerts / vulnerabilities** (Phases 6–9): read the repo's Dependabot **alerts** (the `/security/dependabot` page), dedupe them across manifests, sort each into a **bucket** (fix available & direct → bump it · fix available but transitive → force it via override / lockfile re-resolve · no fix → assess & dismiss-with-reason or replace), and say exactly **what to do** for each — including the ones the PR stream silently never fixes. As an **extra**, it cross-checks every manifest with `npm audit` + `cargo audit` and reports anything they catch that the Dependabot alerts missed.

This command is **read-only** — it never merges, closes, comments, approves, edits, or dismisses anything on GitHub. It produces a triage a human acts on; every fix command it prints is a recommendation for you to run, not something it runs. With `--md` the **only** thing it writes is one local result file.

`$ARGUMENTS` (space-separated, order-independent, all optional):
- An **ecosystem** name (`npm`, `cargo`, `github-actions`, `docker`) → restrict **both** scans to that ecosystem; otherwise show all.
- **`--no-prs`** → skip Scan A (PRs). **`--no-vulns`** → skip Scan B (alerts). Default runs both; passing **both** flags leaves nothing to do — say so and stop.
- **`--md`** → write the result to a file at the repo root instead of printing it (see Phase 10). The content is identical either way; `--md` only changes where it goes.

## Phase 0 — Resolve repo & decide which scans run

```
gh repo view --json nameWithOwner --jq .nameWithOwner
```

Call it `{REPO}`. If it fails, stop and ask the user for the repo.

Parse the flags: run **Scan A** (Phases 1–5) unless `--no-prs`; run **Scan B** (Phases 6–9) unless `--no-vulns`. If both flags are present there's nothing to do — say so and stop. An ecosystem positional, if present, filters **both** scans.

## Phase 1 — Gather

```
gh pr list --repo {REPO} --author "app/dependabot" --state open --limit 100 \
  --json number,title,labels,headRefName,createdAt,url,statusCheckRollup
```

Read PR bodies where the title isn't enough to enumerate grouped deps/versions: `gh pr view <n> --repo {REPO} --json title,body`. If there are zero open Dependabot PRs, say so and skip to Phase 6 (or stop if `--no-vulns`).

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

## Phase 5 — Scan A output (PRs)

Build the PR triage as below. Where it goes (terminal vs `--md` file) is handled in **Phase 10**, which stitches in Scan B's section when both ran.

### Table
One markdown table, sorted safest-first:

```
## Open Dependabot PRs — {REPO}  (N open)

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

## Phase 6 — Gather security alerts (Scan B)

Pull every **open** Dependabot alert for the repo:

```
gh api /repos/{REPO}/dependabot/alerts --paginate -X GET -f state=open -f per_page=100
```

Per alert, keep: `security_advisory.ghsa_id`, `security_advisory.severity`, `dependency.package.ecosystem` + `.name`, `dependency.scope` (`runtime`/`development`), `dependency.manifest_path` (the lockfile), `security_vulnerability.vulnerable_version_range`, and `security_vulnerability.first_patched_version.identifier` (**null = no fix published**). The alerts API labels cargo crates ecosystem **`rust`** (not `cargo`) — map the `cargo` positional to it; `github-actions`/`docker` rarely have alerts. If the call 403s, Dependabot alerts may be disabled or the token lacks the security-events scope — say so and skip Scan B. If there are zero open alerts, say "no open alerts" and skip to Phase 10.

Context — **why these persist even after merging the PR stream**: Scan A's PRs are Dependabot *version updates*, which only bump **direct** deps in the **directories listed in `.github/dependabot.yml`**. Dependabot *security* updates (a separate feature) only open a fix PR when bumping resolves cleanly — so a vuln lingers when it's **transitive**, has **no published fix**, or sits in a **manifest Dependabot doesn't watch**. Phase 7 detects exactly those three.

### Cross-check with local audit tools (the **extra** — catches what Dependabot missed)
Dependabot alerts come from GitHub's Advisory DB over the manifests in its dependency graph. `npm audit` (npm registry advisory DB) and `cargo audit` (RustSec DB) draw on **different databases on different schedules**, and `cargo audit` additionally flags **unmaintained / yanked** crates Dependabot never reports — so they catch gaps. Run them **read-only** across **every** manifest in the repo, including dirs `dependabot.yml` doesn't watch. (Honor the ecosystem positional: `npm` → npm only, `cargo` → cargo only.)

- **npm** — each `package.json` (find with Glob; here: `shade-agent-cli`, `shade-agent-js`, `shade-agent-template`, `tests-in-tee`, `tests-in-tee/test-image`):
  ```
  ( cd <dir> && npm audit --json --package-lock-only )
  ```
  `--package-lock-only` audits the committed lockfile without needing `node_modules`. Read `metadata.vulnerabilities` for counts and the `vulnerabilities` map for advisories (each node lists `via` — match on the **root** advisory/package, not the parents it taints). **Never** run `npm audit fix` — it writes.
- **cargo** — each dir with a `Cargo.lock` (here: `shade-attestation`, `shade-contract-template`):
  ```
  cargo audit --file <dir>/Cargo.lock
  ```
  Read-only; reports advisories **and** unmaintained/yanked warnings. If it isn't installed (`cargo: no such subcommand: audit`), **don't install it** — note "cargo audit unavailable, skipped" and move on.

Keep each finding's advisory id (`GHSA-…` / `RUSTSEC-…` / npm advisory), package, severity, manifest, and fixed version, to reconcile against the Dependabot alerts in Phase 7.

## Phase 7 — Classify each alert

First **dedupe**: collapse alerts sharing a `ghsa_id` + package into one row, listing the manifests they hit (the same advisory in 5 lockfiles = one row, count 5). Then, per distinct (advisory, package):

- **Fix?** — `first_patched_version.identifier` if present, else **none**.
- **Direct or transitive?** — for each affected manifest, read the **sibling manifest source** (not the lockfile) and check whether the package is declared there:
  - npm: the `package.json` next to the `package-lock.json` — is the package a key under `dependencies` / `devDependencies`?
  - cargo: the `Cargo.toml` next to the `Cargo.lock` — is it under `[dependencies]` / `[dev-dependencies]`?
  - Declared in at least one affected manifest → **direct**; declared in none → **transitive**.
- **Watched?** — read `.github/dependabot.yml` and build the set of `{ecosystem, directory}` it lists under `updates:`. The alert's manifest **directory** (parent of `manifest_path`) is **watched** if it matches a configured `directory` for that ecosystem (exact dir; this repo uses one `directory` per entry, not recursive). A manifest dir not in that set (e.g. `tests-in-tee/`, `tests-in-tee/test-image/`) is **unwatched** → no version-update PR will ever touch it. Tag such rows `📂 unwatched`.
- **Severity** — critical / high / medium / low.
- **Exposure** — `runtime` vs `development` scope, and whether the manifest is a **published** artefact (`shade-agent-js`, `shade-agent-cli`, the `shade-attestation` crate) or **not shipped** (templates, `tests-in-tee/*`). A dev-scope or test-only alert is real but lower priority; a runtime alert in a published package is the high-priority case. (npm lockfiles don't ship to consumers of the published packages — consumers re-resolve from your version ranges — so most npm-lockfile alerts are a CI/dev/test surface, not a downstream-consumer one. Note that where it lowers urgency.)
- **Source & audit delta** — tag each finding `dependabot`, `audit` (only `npm`/`cargo audit` saw it), or `both` (match by advisory id, or root package + manifest). The **`audit`-only** set is the payoff of the cross-check — what Dependabot missed: a different advisory DB, an unwatched manifest, a lag, or a `cargo audit` unmaintained/yanked crate. Classify `audit`-only findings with the same fix / direct-vs-transitive / watched logic; treat unmaintained/yanked as a no-fix-class finding (label "unmaintained", not a CVE).

## Phase 8 — Bucket & suggested fix (first match wins)

Each alert lands in exactly one bucket; `📂 unwatched` is an additional tag, not a bucket.

1. **🟢 Direct + fix available** → the easy win. Merge the Dependabot PR that bumps it (Scan A may already list one — cross-reference by package), or bump it yourself: npm `npm i <pkg>@<fixed>` in the package, cargo bump the version in `Cargo.toml`; commit the regenerated lockfile.
2. **🟠 Transitive + fix available** → **the PR stream won't clear these** (it bumps parents, not the indirect dep). Force the patched version:
   - **npm** → add an `overrides` entry to the affected `package.json` (e.g. `"overrides": { "ws": ">=8.21.0" }`), or run `npm update <pkg>` / `npm audit fix` to re-resolve; commit the regenerated `package-lock.json`. Prefer `overrides` when a parent's range pins the old version so a plain update can't move it.
   - **cargo** → `cargo update -p <crate> --precise <fixed>` in the crate dir (works when the fixed version is within the parent's semver range; if not, bump the parent crate); commit `Cargo.lock`.
3. **🔴 No fix published** → Dependabot **cannot** act. Assess reachability + exposure (Phase 7): if the path isn't reachable or it's dev/test-only, **dismiss the alert with a reason** in the GitHub UI (or `gh api -X PATCH /repos/{REPO}/dependabot/alerts/<number> -f state=dismissed …` — a **write**, so this command only *recommends* it, never runs it). If it's a real shipped risk (e.g. a CRITICAL crate in the contract WASM), **replace or remove the dependency** (a code change) or pin a maintained fork.

`📂 unwatched` rows: even a bucket-1/2 fix won't recur via Dependabot here — either **add the directory to `.github/dependabot.yml`** so it's maintained, or accept it (note when it's test-only / never published).

## Phase 9 — Scan B output (vulnerabilities)

Build the alerts triage as below; Phase 10 sends it to the terminal or the `--md` file.

### Table
One deduped markdown table, **critical-first**:

```
## Security alerts — {REPO}  (M open · D distinct)

| Sev | Package | Eco | Scope | Fix | Bucket | Manifests | Advisory |
|-----|---------|-----|-------|-----|--------|-----------|----------|
```
- **Sev** 🔴 critical · 🟠 high · 🟡 medium · ⚪ low.
- **Fix** the patched version, or **none**.
- **Bucket** 🟢 direct+fix · 🟠 transitive+fix · 🔴 no-fix (append `📂` when unwatched).
- **Manifests** short ("`tests-in-tee` +2 more"); tag the `📂` ones.
- **Advisory** the `GHSA-…` id.

State the headline up front: M raw alerts collapse to D distinct (e.g. "26 alerts → 9 packages").

### Per-bucket guidance
For each non-empty bucket, a short block: the **one-line why it persisted**, the **fix recipe** from Phase 8 with the literal command per package (`overrides` / `npm audit fix` / `cargo update -p … --precise …`), and which entries are **`📂 unwatched`** (and whether they're test-only). Lead the 🔴 no-fix bucket with any **critical/high** entry and say plainly whether it's shipped (act — replace/remove) or dev/test-only (dismiss-with-reason).

### Extra — local audit cross-check (what Dependabot missed)
Report only the **`audit`-only** delta from Phase 7 (the alerts already appear in the table above). If it's empty, one line: "`npm audit` + `cargo audit` surfaced nothing beyond the Dependabot alerts — coverage agrees." Otherwise a short table in the same shape with an added **Source** column (`npm-audit` / `cargo-audit`), bucket each finding the same way, and list `cargo audit` **unmaintained / yanked** entries explicitly. Flag any manifest the audit covered that `dependabot.yml` doesn't watch (a coverage gap worth closing). If a tool was unavailable, name it and note its ecosystem's cross-check was skipped.

### Summary
- Counts by bucket and by severity.
- **Audit cross-check**: N `audit`-only findings beyond Dependabot (or "none — coverage agrees"); note any tool skipped.
- **Fix order**: 🟢 direct+fix (merge/bump) → 🟠 transitive+fix (override / re-resolve, one lockfile at a time) → 🔴 no-fix (dismiss-with-reason or replace). Surface critical/high first within each.
- Note any **`📂 unwatched`** dirs and whether to extend `.github/dependabot.yml`.

## Phase 10 — Where the output goes

Assemble whichever scans ran (Scan A's section from Phase 5 first, then Scan B's from Phase 9), then:
- **Default (no `--md`)** → print them to the terminal, Scan A first.
- **`--md`** → write the combined result to `{repo-root}/dependabot-triage-result.md` in a **single** `Write` (resolve the root with `git rev-parse --show-toplevel`; `Write` overwrites any previous file). Start the file with a `# Dependabot triage — {REPO}` header and a one-line "generated read-only on {today}" note, then the section(s) that ran. Don't print the body to the terminal — just confirm the path written and give a one-line headline (counts by bucket for each scan that ran).

Then **stop**. Take no action — the human decides what to merge, close, override, or dismiss.

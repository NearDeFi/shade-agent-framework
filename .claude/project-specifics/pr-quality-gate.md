**Steps that must be completed before an agent can create a PR**

# PR-to-`main` quality gate — shade-agent-framework

Run this before committing and opening a PR into `main`. Work through it top to bottom.

## Hard rules (read first)

1. **Only run the checks for the area(s) your diff actually touched.** This is a monorepo; a docs-only or single-package change does not need every gate.
2. **Never run the end-to-end / sandbox-integration suites in this gate.** `tests-in-tee/` and the heavy `shade-contract-template` sandbox integration tests (`cargo test`, not `--lib`) need live testnet NEAR accounts, a funded sponsor account, and a `PHALA_API_KEY` — real infrastructure, credentials, and cost. They run via the manual, non-blocking `/run-e2e` suite (`.github/workflows/e2e.yml`), which a maintainer can trigger on a `main` or `stable` PR. Flag them in the PR for a maintainer to run; do not run them here.
3. **Rebuild `shade-agent-js` before building anything that consumes it.** `shade-agent-template` (and `tests-in-tee`) import `@neardefi/shade-agent-js` via `file:../shade-agent-js`, whose `dist/` (including the `.d.cts` types) is gitignored and has no `prepare` script — so `npm run build` the library first or `tsc` cannot resolve the import.
4. **A change to `shade-attestation` is a breaking change to `shade-contract-template`.** Run the contract gate whenever you touch the attestation crate.
5. Use `npm i` (not only `npm ci`) when you changed a `package.json`, so the lockfile is reconciled.

---

## Step 1: Determine which area(s) changed

From the repo root, list changed files against the base branch:

```bash
git diff --name-only origin/main...HEAD
```

Map each changed path to an area by its top-level directory:

| Path prefix | Area | Gate to run (Step 2) |
|---|---|---|
| `shade-agent-js/` | shade-agent-js (published JS/TS library) | shade-agent-js gate **+** shade-agent-template gate (it consumes the lib) |
| `shade-agent-cli/` | shade-agent-cli (published deploy CLI) | shade-agent-cli gate |
| `shade-agent-template/` | shade-agent-template (example agent app) | shade-agent-template gate |
| `shade-attestation/` | shade-attestation (Rust crate) | shade-attestation gate **+** shade-contract-template gate |
| `shade-contract-template/` | shade-contract-template (Rust NEAR contract) | shade-contract-template gate |
| `tests-in-tee/` | end-to-end TEE suite | **maintainer-only — do not run locally** (Hard rule 2) |
| `docs/` | documentation | no build gate; verify references match the code you changed |
| `contract-builder/`, `Dockerfile*`, `test-image.Dockerfile`, `rust-toolchain.toml`, `.github/` | build / CI infra | re-run the gate(s) for any area the infra change affects (CI's `all` filter re-runs every job) |

Dependency edges: a change in **`shade-agent-js`** requires re-typechecking **`shade-agent-template`** (the `file:` consumer); a change in **`shade-attestation`** requires the **`shade-contract-template`** gate.

---

## Step 2: Run the gate for each changed area

### shade-agent-js gate

```bash
cd shade-agent-js
npm ci                # use `npm i` if you changed package.json
npm run build         # tsup build — also emits the .d.cts types consumers need
npm test              # vitest unit tests (tests/unit)
cd ..
```

If you changed the public API, also run the **shade-agent-template gate** below.

### shade-agent-cli gate

```bash
cd shade-agent-cli
npm ci
npm run build
npm test              # vitest unit tests (tests/unit)
cd ..
```

### shade-agent-template gate

```bash
# Build the sibling library first (file:../shade-agent-js, gitignored dist/, no prepare script):
cd shade-agent-js && npm ci && npm run build && cd ..
cd shade-agent-template
npm ci
npm run build         # tsc — this is the only gate (no test script)
cd ..
```

### shade-attestation gate

```bash
cd shade-attestation
cargo fmt
cargo clippy --all-targets
cargo test
cd ..
```

### shade-contract-template gate

```bash
cd shade-contract-template
cargo fmt
cargo clippy --all-targets
cargo test --lib      # unit tests only — fast. The full `cargo test` (sandbox integration)
                      # and the wasm build run in the manual /run-e2e suite — NOT here.
cd ..
```

---

## Step 3: Run formatting and checks (always)

This repo has **no JS/TS formatter or linter configured** (no ESLint/Prettier). For the JS/TS packages, `npm run build` (the tsup/tsc build) and `npm test` (vitest) *are* the static checks, and CI runs those same commands — Step 2 already covers them, so there is nothing extra to fix-format there.

For the Rust crates you changed, run the formatter and linter in fixing mode and fix anything they flag:

```bash
# in each changed Rust crate dir (shade-attestation / shade-contract-template)
cargo fmt                    # CI enforces `cargo fmt --check`
cargo clippy --all-targets   # CI runs the same; clippy is lenient (no -D warnings) for now —
                             # still fix every warning your change introduces
```

These are the **fixing** flavor — they rewrite files and surface problems so you fix them here, before pushing. CI (`.github/workflows/ci.yml`) runs the **check** counterpart (`cargo fmt --check`, `cargo clippy --all-targets`, the same `npm run build`/`npm test`) on every PR into `main` and fails on anything left unaddressed, so a clean run here is what makes CI green. **CI is the authority** — its per-area path filtering defines the required `ci-passed` check on every PR into `main`; the heavier `/run-e2e` suite (`.github/workflows/e2e.yml`) is a separate, manually-triggered, **non-blocking** suite. This local gate is the superset that keeps `ci-passed` green.

---

## Step 4: Definition-of-done checklist

A change is **not** ready for `main` until all of the following are true:

- [ ] Changed area(s) identified (Step 1) and each area's gate (Step 2) run green
- [ ] If `shade-agent-js`'s public API changed: `docs/reference/api.md` updated, `shade-agent-template` updated + re-typechecked, and `shade-agent-js/tests/` (plus any affected `tests-in-tee/` scenarios) updated
- [ ] If `shade-agent-cli` changed: `docs/reference/cli.md` updated and every file in `shade-agent-cli/example-deployment-files/` still valid against the parser
- [ ] If `shade-contract-template` changed: `docs/reference/agent-contract.md` updated for any public/owner-gated method, attestation behaviour, or storage-layout change, and consumers (`shade-agent-template`, the CLI) checked
- [ ] If `shade-attestation` changed: `shade-contract-template` still builds and approved-measurement / PPID gating semantics are preserved (contract gate run)
- [ ] End-to-end coverage that can only run under attestation (`tests-in-tee/`, the `/run-e2e` sandbox suite + wasm build) is flagged in the PR for a maintainer to run — never run locally

Universal items (every repo):

- [ ] Formatting and checks (Step 3) run clean
- [ ] Every added or changed code path has unit tests: happy path, edge cases, malicious inputs
- [ ] Bug fixes include a regression test that fails on the unfixed code
- [ ] No secrets (keys, tokens, credentials, customer data) anywhere in the diff
- [ ] Any new dependency is justified in the PR description

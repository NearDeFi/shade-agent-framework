**How to write every commit message in this repository**

# Commit conventions

Every commit message follows the Conventional Commits shape:

```
type(scope): short imperative description
```

- Pick the **type** from the fixed list below — never invent a new one.
- Pick the **scope** from this repository's scope list below. The scope is required when the change is confined to one listed area; omit it (`type: description`) only when the change genuinely cuts across the whole repo.
- Description: lowercase, imperative mood ("add", not "added"/"adds"), no trailing period.
- Breaking change: append `!` after the type/scope — `feat(scope)!: drop X`.
- A commit that spans multiple scopes usually means it should be split into multiple commits; if splitting makes no sense, use the dominant scope.

## Types (fixed list)

| Type | Use for |
|---|---|
| `feat` | new user-facing functionality |
| `fix` | bug fixes |
| `docs` | documentation-only changes |
| `test` | adding or correcting tests, nothing else |
| `refactor` | restructuring code without changing behavior |
| `perf` | performance improvements |
| `build` | build system, dependencies, packaging |
| `ci` | CI / workflow configuration |
| `style` | formatting only, no logic change |
| `revert` | reverting a previous commit |
| `chore` | maintenance that fits none of the above |

## Scopes (this repository's areas)

- `shade-agent-js` — the published JS/TS agent library (`@neardefi/shade-agent-js`)
- `shade-agent-cli` — the published deploy CLI (`@neardefi/shade-agent-cli`), including `deployment.yaml` parsing/validation
- `shade-agent-template` — the example price-oracle agent app
- `shade-attestation` — the Rust crate that verifies TEE attestations in NEAR contracts
- `shade-contract-template` — the Rust NEAR agent contract
- `tests-in-tee` — the end-to-end TEE integration suite
- `contract-builder` — the contract build image / tooling

A documentation change is `docs(<scope>): ...` (e.g. `docs(shade-agent-cli): ...`) or plain `docs: ...` for repo-wide docs; a workflow/CI change is `ci: ...`.

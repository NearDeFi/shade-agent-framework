# shade-agent-cli — Claude guidance

## Error-handling convention

Every CLI error must be rendered the same way:

1. **Red message via `chalk.red`** — single line that names what failed and why, in user-readable terms.
2. **Non-zero exit** — `process.exit(1)`. No fallback, no continuation.
3. **Optional gray detail** — if there's stderr from a subprocess, log it via `chalk.gray` after the red line.

```js
import chalk from "chalk";

console.log(chalk.red(`Error: <what failed and why>`));
process.exit(1);
```

When the error originates inside `src/utils/*` (libraries, no chalk):

- **Throw** an `Error` with a clear message.
- The caller in `src/commands/*` already has a `try/catch` that maps `e.message` into the red+exit pattern. Don't import `chalk` into utils.

## Conventions to keep

- Never `console.log` an error in plain (no-color) text — always `chalk.red`.
- Never let a CLI error path fall through silently or warn-and-continue.
- Never `process.exit(0)` on a failure path — exit code matters for shell scripting and CI.
- Don't catch and swallow — if you catch, re-throw or render+exit.
- Configuration validation errors render at the validation site (`src/utils/config.js` exits directly with red+exit because it's an early-stage gate).

## File map

- `src/commands/*` — top-level CLI verbs. Render errors. Use `chalk.red` + `process.exit(1)` directly.
- `src/utils/*` — pure-ish helpers. Throw on error, no `chalk`, no `process.exit`.
- `src/utils/config.js` — exception: it's the early-stage validation gate and exits directly with the red+exit pattern, since it runs before any command body.

## Doing reviews / fixes

When adding a new check:
- If it's a precondition (e.g. validation), put it at the top of the command function with red+exit.
- If it's a post-condition over a returned value (e.g. comparing what an external service returned vs what we computed), throw with a precise message; the caller's catch renders it.
- Always include the **observed value** and the **expected value** in the error message so the operator can diagnose without re-running.

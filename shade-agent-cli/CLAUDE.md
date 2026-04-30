# shade-agent-cli — Claude guidance

## Error-handling convention

Every CLI error must be rendered the same way, at the site of the failure:

1. **Red message via `chalk.red`** — single line that names what failed and why, in user-readable terms.
2. **Non-zero exit** — `process.exit(1)`. No fallback, no continuation.
3. **Optional gray detail** — if there's stderr from a subprocess, log it via `chalk.gray` after the red line.

```js
import chalk from "chalk";

console.log(chalk.red(`Error: <what failed and why>`));
process.exit(1);
```

This applies everywhere in the CLI — `src/commands/*` and `src/utils/*` alike. Don't `throw` an `Error` and rely on a caller's `try/catch` to render it; render where the error happens.

## Conventions to keep

- Never `console.log` an error in plain (no-color) text — always `chalk.red`.
- Never let a CLI error path fall through silently or warn-and-continue.
- Never `process.exit(0)` on a failure path — exit code matters for shell scripting and CI.
- Don't catch and swallow — if you catch, render+exit.
- Always include the **observed value** and the **expected value** in the error message so the operator can diagnose without re-running.

## Doing reviews / fixes

When adding a new check:
- If it's a precondition (e.g. validation), put it at the top of the function with red+exit.
- If it's a post-condition over a returned value (e.g. comparing what an external service returned vs what we computed), check immediately after the call returns and red+exit on divergence.

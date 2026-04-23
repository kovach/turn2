---
name: run-tests
description: Run the TypeScript test suite via ./run-tests.sh. Use when the user asks to run tests, check test output, verify a change, or names one or more test modules to run. Also trigger after editing files in ts/src/ to confirm nothing regressed.
---

Run tests with the `run-tests.sh` script at the repo root via the Bash tool.

Usage:
- `./run-tests.sh` — runs every `ts/src/tests/*.test.ts` file.
- `./run-tests.sh <name> [<name> ...]` — runs only the named tests, resolved as `ts/src/tests/<name>.test.ts`. Example: `./run-tests.sh parse tree` runs `parse.test.ts` and `tree.test.ts`.

Rules:
- Names are bare module stems — no path, no `.test.ts` extension. The set of valid stems is whatever lives in `ts/src/tests/` right now; list that directory if you need to know.
- Prefer a filtered run when you know which module you touched; fall back to the full run before reporting work complete.
- Script uses `set -e` and exits non-zero on the first failing test. Output ends with `all tests passed` on success.

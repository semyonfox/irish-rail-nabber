# Blockers

## Current blockers
- None blocking feature completion in this repository state.

## Resolved during work
- `cargo` in this environment routes through a rustup shim that can be blocked by proxy settings. Worked around by using `/home/semyon/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/cargo` for checks.
- Could not verify live DB migration execution from this environment because `DATABASE_URL`/runtime container context was not available.

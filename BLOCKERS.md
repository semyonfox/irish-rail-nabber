# Blockers

## Current blockers
- `/chat` requires `LLM_API_KEY` or `OPENAI_API_KEY` at runtime; without one every call returns 500.
- Session persistence / history streaming are not yet implemented; current implementation is one-turn JSON.

## Resolved during work
- `cargo` in this environment routes through a rustup shim that can be blocked by proxy settings. Worked around by using `/home/semyon/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/cargo` for checks.
- Could not verify live DB migration execution from this environment because `DATABASE_URL`/runtime container context was not available.

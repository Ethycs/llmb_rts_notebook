# R2-prototype verification report

Status: not yet run

This is the operator-filled report stub for the R2-prototype harness at
[`r2-prototype/`](r2-prototype/). Run the harness end-to-end with

```bash
pixi run -e kernel python _ingest/prototypes/r2-prototype/run_smoke.py
```

then replace each italic placeholder below with the observed values.

## Run metadata

- **Date:** *YYYY-MM-DD of the run*
- **Machine:** *operator's hostname / OS / arch (e.g. `windows-11-amd64`,
  `macos-14-arm64`, `linux-debian-12-amd64`)*
- **Claude Code version:** *paste the output of `claude --version`*
- **Anthropic API model used:** *paste the `model` field from the first
  request in `r2-prototype/run.log`*
- **Harness commit hash:** *paste the output of `git rev-parse HEAD` taken
  immediately before the run, so the report is bound to a specific tree*

## Invariant results

For each of the four invariants emitted by `run_smoke.py`, mark PASS or FAIL.
On FAIL, paste the actual log line(s) that establish the failure.

1. **Agent emitted at least one `notify` tool call.** *PASS | FAIL — paste
   relevant entries from `r2-prototype/.run/kernel.log.jsonl`*
2. **Agent stdout contained no free-form prose.** *PASS | FAIL — if FAIL,
   paste the offending stdout lines from `run_smoke.py`'s captured stream*
3. **Model call routed through the stub LiteLLM proxy.** *PASS | FAIL —
   paste the first entry from `r2-prototype/run.log`, or note that the file
   is empty / missing*
4. **`run.start` has a matching `run.complete`.** *PASS | FAIL — paste the
   matching pair from `r2-prototype/.run/run.trace.jsonl`*

## Deviations from RFC-002

List every observed behavior that contradicts the recipe in
[`docs/dev-guide/08-blockers-mediator-standards.md`](../../docs/dev-guide/08-blockers-mediator-standards.md)
("RFC-002 — Claude Code provisioning procedure" subsection). For each
deviation, flag whether RFC-002 should be amended (the spec was wrong) or
whether the implementation should change (the spec was right but the
harness/runtime is out of sync).

- *e.g. "Claude Code does not accept `--system-prompt` as a path; only
  inline string. Recommend RFC-002 amendment to spawn via stdin instead."*
- *e.g. "`CLAUDE_CODE_DISABLED_TOOLS` env var is ignored; only the
  `--disallowed-tools` flag works. Recommend implementation change."*
- *(add bullets as needed)*

## Recommended RFC-002 amendments

Short patch-style descriptions of each amendment needed before RFC-002 can
be ratified. Each entry should be small enough to fit in a single PR.

- *e.g. "Replace `CLAUDE_CODE_SYSTEM_PROMPT_FILE` env var with explicit
  `--system-prompt-file <path>` CLI flag throughout RFC-002 §3."*
- *(add bullets as needed)*

## Sign-off

- **Name:** *operator name*
- **Date:** *YYYY-MM-DD*
- **Status:** *one of `clean` | `needs amendment` | `blocked`*
  - `clean` — all four invariants PASS; no RFC-002 amendments required
  - `needs amendment` — invariants pass with a patched harness, but RFC-002
    must be amended before ratification
  - `blocked` — one or more invariants FAIL with no clear amendment path;
    requires synchronous design discussion before re-running

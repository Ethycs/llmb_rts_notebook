# Reference conformance suite

The reference suite for the merged `feature/facade-consumers`, `feature/drift-everywhere` and
`feature/magic-defense` work: real pty-mode, serve, app and facade sessions plus in-process checks,
each tied to the RFC/PLAN section it enforces. It complements the agent-written suites in
`vendor/LLMKernel/tests/conformance/` and `tests/conformance/`.

Run from the notebook root through pixi:

    pixi run -e kernel python -m pytest tests/conformance/reference

The tests start real kernel processes; `hook/` and `integration_hook/` are `sitecustomize` probes
put on the child's PYTHONPATH to count facade starts and subsystem construction.
Set `LLMNB_APP_ROOT` to point at another notebook checkout.

To check that a suite catches documented regressions, see `tools/conformance_mutation/`.

# Conformance mutation check

`mutants.py` holds 23 seeded regressions, each breaking one documented contract of the merged
features (`CONTRACTS` names the RFC/PLAN section). `run.py` applies them one at a time, runs the
conformance tests, restores the files, and reports CAUGHT or SURVIVED.

    pixi run -e kernel python tools/conformance_mutation/run.py --list
    pixi run -e kernel python tools/conformance_mutation/run.py                    # all mutants
    pixi run -e kernel python tools/conformance_mutation/run.py -m ready-frame-no-session-id \
        --tests kernel:tests/conformance notebook:tests/conformance

Run it from a clean checkout; it refuses to start if a file it would mutate has local changes.

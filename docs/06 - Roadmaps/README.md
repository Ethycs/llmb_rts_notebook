# 06 - Roadmaps

Forward-looking planning — where the project is headed and why.

## The strategic narrative

**[`ROADMAP.md`](ROADMAP.md)** — the single strategic-narrative doc that ties together V1 status, V2 lane (shipped + queued), V2.5/V3 territory, the genuine API ceilings, and architectural non-goals. Read first to know "where is this going."

## Operational analogs (in sibling folders)

The operational roadmap-flavored plans physically live in [`../07 - Status Reports/`](../07%20-%20Status%20Reports/) alongside the per-slice execution plans. The ones that read as roadmap-style rather than status-style:

- [`PLAN-v1-roadmap.md`](../07%20-%20Status%20Reports/PLAN-v1-roadmap.md) — the 14-row V1 ship-ready checklist. Rows 1-11 (operator-visible UX) are ✅.
- [`BSP-005-cell-roadmap.md`](../03%20-%20Blueprint/BSP-005-cell-roadmap.md) — V1 slice ladder (§6.5) + V2 lane queue (§6.6). Lives in Blueprint because it's normative for slice ordering.
- [`PLAN-M-series.md`](../07%20-%20Status%20Reports/PLAN-M-series.md) — the M-series milestone plan (M1-M4).
- [`PLAN-substrate-gap-closure.md`](../07%20-%20Status%20Reports/PLAN-substrate-gap-closure.md) — substrate trajectory.

## How to use this folder

- **Day-to-day implementation work** → start at the relevant `PLAN-*` slice doc in 07.
- **"What slice next?"** → BSP-005 §6.5 (V1) or §6.6 (V2 lane).
- **"Are we going the right direction?" / "What's blocked?" / "What's the V3 horizon?"** → [`ROADMAP.md`](ROADMAP.md) here.

`ROADMAP.md` is updated when a campaign closes, when a ceiling is discovered, or when an honest deferral changes the queue — not after every slice.

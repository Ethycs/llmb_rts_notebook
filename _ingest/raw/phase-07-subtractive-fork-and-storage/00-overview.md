# Phase 07: Subtractive fork, LLMKernel scope, and storage design

**Merged turn range:** 077–093  
**Sub-turns:** 17  
**Slug:** `subtractive-fork-and-storage`

## Summary

User commits to a subtractive fork of vscode-jupyter (cut Python integration, IPyWidgets, remote servers, debugging, viewers; hardcode LLMKernel as sole kernel). Designs three-tier storage (layout tree, agent state graph, chat flow JSON), then collapses it into a single embedded .llmnb file. Establishes testing strategy for Jupyter messaging protocol and lifecycle bugs.

## Decisions in this phase

- **DR-0011** [LOCK-IN] — Subtractive fork of vscode-jupyter (turns 079, 080)
- **DR-0012** [SCOPE-CUT] — LLMKernel hardcoded as sole kernel; no kernel discovery (turns 083)
- **DR-0013** [LOCK-IN] — V1 scope confirmed feasible with Claude Code as collaborator (turns 085)
- **DR-0014** [LOCK-IN] — Three storage structures (layout tree, agent graph, chat flow) embedded in single .llmnb file (turns 081, 082, 083)

## Sub-turn table of contents

| Turn | Role | Source lines | Chars | File |
| ---- | ---- | ------------ | ----- | ---- |
| 091 | user | 9495–9500 | 279 | [turn-091-user.md](turn-091-user.md) |
| 092 | assistant | 9501–9832 | 25320 | [turn-092-assistant.md](turn-092-assistant.md) |
| 093 | user | 9833–9838 | 50 | [turn-093-user.md](turn-093-user.md) |
| 094 | assistant | 9839–10158 | 20457 | [turn-094-assistant.md](turn-094-assistant.md) |
| 095 | user | 10159–10164 | 111 | [turn-095-user.md](turn-095-user.md) |
| 096 | assistant | 10165–10678 | 26900 | [turn-096-assistant.md](turn-096-assistant.md) |
| 097 | user | 10679–10684 | 84 | [turn-097-user.md](turn-097-user.md) |
| 098 | assistant | 10685–11111 | 23797 | [turn-098-assistant.md](turn-098-assistant.md) |
| 099 | user | 11112–11117 | 111 | [turn-099-user.md](turn-099-user.md) |
| 100 | assistant | 11118–11351 | 19396 | [turn-100-assistant.md](turn-100-assistant.md) |
| 101 | user | 11352–11357 | 146 | [turn-101-user.md](turn-101-user.md) |
| 102 | assistant | 11358–11833 | 23081 | [turn-102-assistant.md](turn-102-assistant.md) |
| 103 | user | 11834–11839 | 70 | [turn-103-user.md](turn-103-user.md) |
| 104 | assistant | 11840–12055 | 19079 | [turn-104-assistant.md](turn-104-assistant.md) |
| 105 | user | 12056–12061 | 101 | [turn-105-user.md](turn-105-user.md) |
| 106 | assistant | 12062–12452 | 22923 | [turn-106-assistant.md](turn-106-assistant.md) |
| 107 | user | 12453–12458 | 107 | [turn-107-user.md](turn-107-user.md) |

## Reconciliation notes

Merged Agent C's 'notebook-substrate-fork' (077-082), 'fork-approach-and-scope' (083-087), and 'storage-and-testing' (088-093) into one phase. They share a single thread: 'what to keep from vscode-jupyter and how to structure the data the survivor produces.' Splitting them creates artificial boundaries inside one continuous design exercise.

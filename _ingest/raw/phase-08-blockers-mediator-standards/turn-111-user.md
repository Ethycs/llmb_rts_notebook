---
turn_id: 111
merged_turn_id: 097
role: user
phase: 08-blockers-mediator-standards
source_lines: [12841, 12847]
source_sha256: 26c76b97b2732c6dc168f7db25791021d21eb978be9ffa138fce968a81588a02
char_count: 1148
---



## User

LLMKernel hosts  an MCP server, it works like a standard server, LLM kernel can also act as a PTY and handles API and tool lifecycle before delivering to frontend. For now we use python for all these things. No zone/sandbox implementation, is developed in V2. For now use Vscode and reverse mcping extensions as scope. Focus is on getting the reverse communication to work, we don't really care what the model context does as long as we can control its functionality. 5 is there anything in langsmith that is like stub + content? Use simdjson and careful editing to inject the right data into json. calls/runs are no different then any chat window to LLMkernel. Rely on git functionality exactly for branching semantics, let the notebook itself be a live record of agent states and control behavior with git exactly. 7. We push for tighter integration in notebook cells and deprecate mulitple types of kernel. For now calls retain I/O with input output pairs treat as markdown, and also the LLM kernel magic cells.
Kernel logs should be langsmith blobs and replayable with harness. Hard break between kernel failure vs notebook failure


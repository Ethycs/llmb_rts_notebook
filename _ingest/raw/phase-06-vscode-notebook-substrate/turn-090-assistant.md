---
turn_id: 090
merged_turn_id: 076
role: assistant
phase: 06-vscode-notebook-substrate
source_lines: [9324, 9494]
source_sha256: 6d7c860770b4d898e5e8102999645a9c4fb6af61e5589f685ec85c818fb4ae0f
char_count: 18575
---



## Assistant

Good. Now I have enough to walk you through the actual architectural surface of vscode-jupyter and where the load-bearing decisions sit when you fork. This is more concrete than the previous turn — the extension has well-documented internal architecture and the right places to cut into it are not where you'd guess.

The codebase has four main code areas: notebooks (the integration with VS Code's notebook editor and controllers, responsible for `.ipynb` notebooks managed by VS Code's builtin serializer), interactive-window (the alternative split-editor view), webviews (extension-side and webview-side code for Variable view, data viewer, plot viewer), and standalone (decoupled features like the public API and IntelliSense) Claude API Docs.

The codebase is also split by environment via file extensions: `*.node.ts` for desktop-only code, `*.web.ts` for web-only, and unsuffixed files for shared isomorphic code, with separate entry points (`src/**/serviceRegistry.node.ts` for desktop) Claude API Docs. This matters because when you fork, every architectural decision has a desktop and a web answer, and you have to pick which environments you're targeting.

The kernel architecture has three load-bearing components: discovery (finding kernel specs on the user's machine, connecting to remote Jupyter servers, turning Python environments into Jupyter specs), kernel launcher (launching the selected kernel with proper environment), and execution (handling messages between extension and kernel) GitHub.

The kernel-discovery split is real and has different implementations: globally installed kernel specs are started as separate processes by default and the extension connects through ZeroMQ; Jupyter servers created outside the extension are connected via the Jupyter Server API; Python environments can be used as kernels by installing ipykernel and starting them as processes GitHub.

Then there's an extensibility layer: a public API for external partners to interface with, including capabilities like registering remote Jupyter server URI providers via `jupyterRemoteServerProvider` in package.json contributes and calling `registerRemoteServerProvider` from extension activation Openclaw.

That's the lay of the land. Now let me work through where the architectural decisions actually sit when you fork.

Given your goal — keep the kernel (LLMKernel), control the entire experience including RTS visualization, custom file format treatment, custom UI surfaces — there are exactly four architectural cuts you have to make. The rest of the fork is just inheritance of upstream's decisions.

Three options, ordered by how aggressive the fork is:

Option A: Coexist with upstream. Your fork registers under a different extension ID (`ethycs.vscode-rts-jupyter`), claims a different file extension (`.rts.ipynb` or `.rts`), and runs alongside Microsoft's extension. Operators install both. Standard `.ipynb` opens in Microsoft's; `.rts.ipynb` opens in yours.

This is the lightest touch. You get to make changes without breaking anyone's standard Jupyter workflow. The fork is a sibling, not a replacement.

Option B: Replace upstream for users who install yours. Your fork claims `.ipynb` itself, conflicting with the upstream extension. Operators have to disable Microsoft's. Aggressive, breaks normal workflows, only justified if your changes really do need to own the standard file type.

Option C: Hard fork with renaming. You fork, rename everything, target a separate audience (your tool's users specifically), and don't try to interoperate with upstream. Full ownership. Most maintenance burden but most freedom.

For your case, Option A is clearly right. The RTS use case is distinctive enough that a separate file extension is honest and avoids stepping on standard Jupyter usage. The "decision" then collapses into "what file extension and naming."

The upstream extension supports several kernel sources: globally installed kernel specs (your case for LLMKernel), Jupyter servers (remote), Python environments via ipykernel injection, and the Python extension's environment management. When you pick a kernel in the kernel picker, that kernel is associated with the file and automatically selected next time; without selection, the extension reads notebook metadata and picks a "suggested" kernel NVIDIA Developer.

For your fork, three sub-decisions:

Sub-decision 2a: Lock the kernel choice for .rts.ipynb files. Operators don't pick a kernel — your file format is bound to LLMKernel by metadata. This removes a confusing step and prevents users from accidentally running RTS notebooks against vanilla IPython.

Sub-decision 2b: Drop or keep the other discovery paths. The Jupyter-server discovery, remote-kernel support, and Python-environment integration are all plumbing for the standard data-science workflow. For RTS you don't need any of it. Cutting it simplifies the fork dramatically — but you lose remote-kernel support if you ever want it later.

I'd argue: keep the global-kernel-spec path (where LLMKernel lives), drop or hide the others for .rts.ipynb files. They can stay in the codebase for standard `.ipynb` if you decide to handle those too, but for RTS files the kernel is fixed.

Sub-decision 2c: Custom kernel-startup logic. When LLMKernel starts for an RTS notebook, it might need extra environment setup — MCP server config, zone bindings, agent registry. This is a custom step that goes in the kernel launcher path. Fork or extend the launcher to do this for RTS files.

This sub-decision is concrete code: a new conditional in the launcher that, for RTS files, sets specific env vars and command-line flags. ~50 lines of TypeScript.

This is the big one for the RTS visualization. The upstream extension renders cells via VS Code's built-in notebook editor (which uses NotebookController and renderer extensions). For RTS visualization, you have three places to intercept:

Intercept point A: Output rendering only. Custom MIME types in your kernel emit RTS-specific output (a tool call, a permission request, a status update). Your fork registers renderer extensions that handle these MIME types. The notebook editor itself is unchanged; only what's inside cell output is different.

This is the lightest intervention. The fork mostly inherits upstream's editor, just adds renderers. Renderers can be quite rich — they're webviews with full HTML/CSS/JS — so you can do meaningful UI inside them.

Intercept point B: Add custom panels alongside the editor. A new sidebar contribution, a custom webview panel for the RTS map, status bar items. The notebook editor renders cells normally; the map view sits beside it. The two communicate via your fork's coordinator code.

This is moderate intervention. The notebook editor stays untouched; the RTS map is a new VS Code surface alongside it. Coordination between the two is your responsibility.

Intercept point C: Replace or significantly modify the notebook editor itself. This is what would be required if you wanted, say, the cells to share screen real estate with the map view in a single composed editor surface, or if you wanted custom cell types beyond code/markdown that the standard editor can't render.

This is heavy intervention. The `notebooks` directory is "responsible for integrating Jupyter kernels into .ipynb notebooks managed by VS Code builtin serializer" Claude API Docs — modifying this means changing how the editor itself works, fighting VS Code's builtin notebook system, possibly running into the limits of what extensions can customize.

For v1, Intercept points A and B together are almost certainly enough. Custom renderers handle the rich tool-call output inside cells; a sibling panel hosts the RTS map. You don't need to modify the notebook editor itself, just compose around it.

The map-view panel is structurally similar to the existing webview-based features (Variable view, data viewer, plot viewer) YouTube, which gives you a template — your fork already has the patterns for "extension-side and webview-side code for a feature panel" in the `webviews` directory.

If you ever need Intercept C, you'd be looking at the `notebooks` directory's controller and editor integration. But you can defer that decision until you find a specific feature that requires it.

The RTS visualization (map view) needs to reflect the same state as the notebook (cells). When the agent makes a tool call, both the cell output and the map should update. When the operator approves a permission in the cell, the map should reflect the approved action. When the operator clicks a zone in the map, the relevant cells should highlight.

This cross-surface state coordination is the hardest design problem in the fork, and it's not solved by Jupyter's architecture — Jupyter assumes one editor showing one notebook, not a composed view.

Three approaches:

Approach A: Kernel as the source of truth. Both the notebook cells (via the kernel protocol) and the map view (via custom kernel messages) read from and write to the kernel's state. The kernel publishes state-change events; both surfaces subscribe.

This is the cleanest approach and matches the kernel's nature as a stateful process. Your kernel maintains the world model (zones, agents, events); both UI surfaces are views over it. State sync happens via kernel messages.

Approach B: Extension-side state with kernel as data source. The fork maintains its own state model in TypeScript, populated from the kernel. UI surfaces subscribe to the extension's state.

This decouples the UI from kernel protocol details but adds a synchronization layer (kernel state → extension state → UI). Extra complexity, minimal benefit unless you have non-kernel state.

Approach C: Per-surface state, no shared model. Cells render their own state; map renders its own state; operators use both independently. No coordination beyond what each surface gets from the kernel separately.

Simplest but loses the integration that makes the dual-view valuable.

For v1, Approach A is right. The kernel is already the central state holder; surfaces are views; coordination is via kernel messages with a custom message type for RTS-specific events. This matches the architecture you already have with LLMKernel.

The implementation is concrete: define a custom kernel message type (e.g., `rts.state_update`) that the kernel emits when zones, agents, or events change. The fork's coordinator code subscribes to these messages and dispatches updates to both the cell renderers and the map panel. ~300 lines of TypeScript.

Pulling these decisions together, here's what your fork actually has to do, concretely:

1. Branding and metadata changes. Rename the extension, change the publisher, update IDs. Register `.rts.ipynb` (or whichever extension you pick) as a new file type. This is mechanical but tedious — search-and-replace on `ms-toolsai.jupyter` to your IDs across `package.json`, manifests, command names. ~half a day.

2. File-type-specific kernel binding. For `.rts.ipynb` files, lock the kernel selection to LLMKernel; hide other kernel options. Add custom kernel-startup logic (env vars, MCP config, zone setup). ~one day.

3. Custom MIME type renderers. Define MIME types for RTS-specific outputs: `application/vnd.rts.tool-call+json`, `application/vnd.rts.permission-request+json`, `application/vnd.rts.status+json`, `application/vnd.rts.plan+json`, etc. Implement renderer extensions for each. ~one week for five renderers, with iteration.

4. RTS map view panel. New webview panel registered as a sibling of the cell editor. Initial content can be a simple p5.js or canvas-based map showing zones and agents. Subscribes to kernel state updates via custom messages. ~one week for a v1 map.

5. Sidebar contributions. Activity Bar item for RTS, with tree views for zones, agents, recent activity. Standard VS Code extension API; not Jupyter-specific. ~two days.

6. Custom kernel messages for RTS state. Define and implement the message types. Wire kernel emission in LLMKernel; wire reception in the fork. ~two days.

7. Cross-surface coordination. When a cell updates, optionally update the map; when the map is clicked, optionally focus a cell. ~two days.

8. Cut what you don't need. The fork inherits a lot of code for things you don't use: Python environment integration, Jupyter server discovery, IPyWidgets, notebook diff tools (maybe keep), data viewer, variable viewer, Interactive Window. You don't have to remove these — they can stay dormant, only activated for standard `.ipynb` files. But if you want a focused fork, prune them. ~one week for aggressive pruning.

Total scope: ~3-4 weeks of focused work for a v1 fork that does what you want, leveraging your existing LLMKernel.

The pruning is optional for v1. You can leave upstream's code alone, just register your overrides for `.rts.ipynb` files, and ship a working fork in ~2-3 weeks.

The upstream extension is large and rapidly evolving. Some practical fork strategy:

Fork from a specific stable commit, not main. Pick a recent release tag (their "stable" releases come every few weeks). This gives you a known-good baseline.

Plan to rebase periodically, not constantly. Microsoft pushes a lot of changes; tracking every commit is exhausting. Aim for a quarterly rebase against a recent stable release, with security-fix cherry-picks in between.

Identify the parts you actually modified. Keep a clear list: what files you changed, what you added new, what you removed. This makes rebases manageable. ~10-20 changed files for v1, probably; new files in their own directories.

Use the extension-environment split deliberately. The desktop-only paths (`*.node.ts`) are simpler than the web-environment paths (`*.web.ts`). For v1, target desktop only. Don't fork the web-environment code; let it stay broken or deleted. Web support comes later if it ever does.

Don't try to track every upstream feature. They'll add things; you don't need them. Pick what's relevant to your use case and let the rest drift.

Ship via OpenVSX, not VS Code Marketplace. Microsoft's Marketplace has policies that may complicate publishing a fork. OpenVSX is the open-source registry that VSCodium and Cursor use. The Jupyter extension is already on OpenVSX Substack as a precedent.

Stating them concretely so you can match against them as you work:

These are the architectural commitments. Everything else is implementation detail, working within these constraints.

Concrete week-1 plan, given the architecture:

Day 1: orientation. Clone vscode-jupyter. Build it from source. Run it locally. Open the codebase in VS Code; trace how a cell execution flows from user input through kernel discovery, launching, and output rendering. You're learning the codebase, not changing anything yet.

Day 2: rebrand and register. Fork the repo. Change extension ID, publisher, IDs. Register `.rts.ipynb` as a file type. Build and install your fork; verify it loads.

Day 3: kernel binding. Ensure that opening `.rts.ipynb` files automatically uses LLMKernel without prompting. Test the flow.

Day 4-5: first custom MIME renderer. Pick one (the tool-call renderer is a good first target). Define the MIME type. Make LLMKernel emit it for tool calls. Implement the renderer extension. Verify cell output shows your custom rendering.

End of week 1: you have a working fork that opens RTS files in your custom environment with LLMKernel, and one type of structured output renders custom in cell output.

This is the foundation. Weeks 2-4 build on it.

Forking vscode-jupyter is real work but tractable when you focus the architectural decisions on the four cuts that matter: coexistence with upstream, kernel binding for your file type, rendering intervention at the output (not editor) level, and kernel-state-as-truth for cross-surface coordination.

The fork doesn't need to touch most of upstream's code. The big areas — Python environment management, remote Jupyter server discovery, Interactive Window, IPyWidgets, debugging — can stay dormant or be cut later. Your additions sit in custom MIME renderers, a webview-based map panel, sidebar contributions, and a small amount of kernel-startup customization for your file type.

Total v1 fork scope: 3-4 weeks of focused work, with a usable foundation in week 1.

Decisions worth locking before you start cutting code:

Want to dig into the custom MIME renderer implementation specifics, the map view's webview communication pattern, the kernel-state message protocol design, or the detailed week-by-week build plan for the fork?

1. Coexistence with upstream: register a new extension ID and a new file extension (.rts.ipynb or similar). Don't claim standard .ipynb.
2. Kernel binding: lock LLMKernel for RTS files. Cut the other kernel-discovery paths from the RTS-file flow. Keep them for standard .ipynb only if you support those.
3. Custom kernel-startup: set RTS-specific env vars, MCP config, and zone setup when LLMKernel starts for an RTS file.
4. Rendering interception at output level: custom MIME types and renderers in cell output. Don't modify the notebook editor itself.
5. RTS map as sibling webview panel: model the map view on the existing webview features (Variable view, Plot viewer). Use the same extension-side + webview-side code pattern.
6. Sidebar Activity Bar contribution: new tree views for zones, agents, recent activity. Standard VS Code extension API.
7. Kernel state as source of truth: define custom kernel messages for RTS state. Both cells (via output) and map view (via webview messages) subscribe to kernel state.
8. Desktop-only for v1: drop or ignore the web environment code paths. Target Node-environment desktop VS Code.
9. Extension-environment split: maintain the upstream pattern of *.node.ts files for your additions, even if not strictly needed yet, for future flexibility.
10. Pruning is optional: leave upstream code dormant for v1; prune later if it gets in the way.

1. File extension: .rts.ipynb (compatible with .ipynb tooling) or .rts (clean break)? I'd argue .rts.ipynb.
2. Branding: name and publisher for the fork.
3. OpenVSX vs Marketplace: OpenVSX is the cleaner publishing target.
4. Desktop-only commitment: confirm and remove web-environment burden from your concerns.
5. First MIME type: which one to render first? Tool calls, probably, since they're most frequent.
6. Kernel-state message format: define the custom kernel message types for RTS state.
7. Map view technology: p5.js, canvas, SVG, or webview-embedded React? Pick once.


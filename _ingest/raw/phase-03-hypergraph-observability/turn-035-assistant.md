---
turn_id: 035
merged_turn_id: 026
role: assistant
phase: 03-hypergraph-observability
source_lines: [2492, 2711]
source_sha256: 6d1c6246a7b6595cff6b8564987749d0e93013a05ad816a618932823b4fcef5b
char_count: 16364
---



## Assistant

Good question to front-load, because the answer reshapes the architecture. Short version: Linux (including WSL2) is straightforward and gets you everything we've been designing. macOS is fundamentally different and you'll end up with a separate implementation path for it, not a port.

Let me work through both honestly.

WSL2 is a real Linux kernel running in a lightweight VM. From the perspective of your chroot/bubblewrap engine, it is Linux. Namespaces, cgroups, overlayfs, bubblewrap all work. You install `bubblewrap` via `apt` and your Rust engine works unmodified.

Caveats worth knowing but not worrying much about:

For your project, treat WSL2 as Linux. It is Linux. One codepath, one binary, same tests. The operator happens to be running it on Windows; that's a deployment detail, not an architecture concern.

The only thing worth doing for Windows users specifically is a small onboarding shim: a PowerShell script that checks for WSL2, installs the right distro if needed, and drops them into a working shell inside WSL where your engine runs. Everything else is identical.

macOS does not have:

macOS does have:

This is a different operating system with different primitives. You can't "port" a bubblewrap-based engine to macOS; you have to implement the same semantics using different mechanisms. Let me walk the real options.

Plain `chroot` still works on macOS. Your engine creates a directory per agent, copies or symlinks in what's needed, `chroot`s, drops privileges (maybe), execs the agent. You lose:

You keep:

This is defensible as a v1 macOS story if you're honest about what's weaker. For friendly agents in a dev environment, filesystem isolation + SDK-layer permission hooks gets you most of the value.

macOS's `sandbox_init` API reads a Scheme-based policy language (SBPL) that can restrict file access, network, IPC, process creation, etc. at the kernel level. It's what Apple's own sandboxing uses.

You load this policy before exec'ing the agent. It applies to the process tree.

Pros: real kernel-enforced restrictions on filesystem, network, and IPC. More fine-grained than chroot.
Cons: Apple has marked the API as deprecated for years and still uses it internally, which is classic Apple — it works fine, there's no replacement, but the headers warn you. The documentation is sparse; most real knowledge comes from reverse-engineering and blog posts. Policy language is finicky. No official spec.

The honest state: `sandbox_init` is usable, Chrome and Firefox use it for their renderer sandboxes on macOS, but you're operating on semi-undocumented infrastructure. The deprecation status is "will be there for years but we don't promise forever."

If you go this route, you end up maintaining SBPL policies alongside your Linux/bubblewrap configs, which is a real translation burden.

Apple's Virtualization.framework (macOS 11+, much better on Apple Silicon) lets you run a lightweight Linux VM natively. Tools like Lima, OrbStack, UTM, and Tart all build on it. The design:

This is essentially "Linux on macOS via a sanctioned VM path," and it's become the de facto answer for any serious dev tool that needs Linux primitives. Docker Desktop does this. OrbStack does this. The overhead on Apple Silicon is genuinely small.

Pros: you have one codepath (Linux/bubblewrap). macOS becomes a launcher that starts the VM and forwards to it. Identical semantics everywhere.
Cons: the user installs a VM runtime. You depend on the VM being healthy. Filesystem I/O across the host/guest boundary (if you want the operator to edit files in macOS-native tools) needs a shared-folder mechanism (VirtioFS, SMB, SSHFS) which has its own performance and reliability characteristics.

This is probably the right answer.

Specialization of Option 3: don't implement VM management yourself, require the user to install one of these and run your engine inside it (as a container, or via `lima shell`, or similar).

Pros: zero VM management code in your engine.
Cons: the user installs Docker Desktop (licensing issues for commercial use) or OrbStack (excellent but paid for pro use). You're depending on their product.

Useful as a stopgap ("for macOS users, run our Linux image in Docker Desktop for now") but not a long-term solution.

Apple shipped a native container runtime and `container` CLI in macOS 15+ for Apple Silicon. It uses Virtualization.framework, runs OCI images, native tool, no Docker Desktop needed. If you're on recent Apple Silicon Macs, this is becoming the sanctioned path.

State of this as of 2026: still early, smaller community than Docker/Podman, but Apple-native so it'll mature. Worth watching; probably not what you build on today unless you're targeting newer Macs exclusively.

Three honest paths, pick one:

Path A, strongly. Here's why:

Path A is what Docker did (Docker Desktop is a VM). It's what Podman Desktop does. It's what essentially every serious Linux-primitives-based developer tool does on macOS. Your project is well-suited to join that pattern.

Your codebase:

The Mac launcher is ~500 lines if you write it. If you skip it, Mac users `ssh` into their VM and operate from there, which is also fine for a technical audience.

This is the one genuinely annoying thing about Path A. Agents are inside the Linux VM and writing to `/rts/zones/alpha/workspace/foo.py`. The operator on the Mac wants to click a file and have it open in Cursor/VS Code/whatever Mac-native editor they use.

Solutions:

OrbStack in particular has made this mostly transparent — their shared-folder story Just Works for most cases. VS Code Remote is the complementary piece: the editor knows how to reach into the VM and open files in-place.

None of these are your problem to build. They're platform integrations you document.

Since you asked about both together, a few more WSL2 notes:

systemd is opt-in. Add `[boot]\nsystemd=true` to `/etc/wsl.conf` if you want systemd-based services inside WSL2. For your engine this matters only if you choose systemd-nspawn (which I'd argue against) or if you want to run your engine as a systemd unit. Neither is required.

Filesystem location matters for performance. Anything under the WSL2 root filesystem (`/home/user/rts/...`) is fast. Anything under `/mnt/c/` (mapped Windows filesystem) is slow for lots of small file operations, which is exactly what agents generate. Keep zones inside WSL2's native filesystem. Operators can still access them from Windows via `\\wsl$\Ubuntu\home\user\rts\...` or more conveniently through VS Code's WSL integration.

Networking is straightforward in WSL2. The VM has its own IP on the host, and localhost is forwarded through. Per-agent network namespaces work normally inside WSL2.

Multi-distro isolation as a bonus. A power user could run your engine in its own WSL2 distro (separate from their main dev distro) for extra isolation. Probably overkill but worth noting.

File watching can be flaky across the boundary. If you use `inotify` on files in `/mnt/c/`, it doesn't reliably fire. Irrelevant if zones stay WSL-native; relevant if you try to let agents work on Windows-side files.

WSL2: zero additional work. Treat as Linux. Document "install a Linux distro via WSL2, install bubblewrap, run the engine" and you're done. Windows users get the full Linux experience.

macOS: requires a decision. Path A (Linux VM) is the right one for almost every reason that matters. Path B (native macOS implementation) is technically possible via `sandbox_init` but costs you forever and gives you a weaker version. Path C (no Mac support) is too narrow.

The practical plan:

The architecture stays pristine: one engine, one set of semantics, one test matrix, one set of behaviors to reason about. The Mac story is operational (install a VM) rather than architectural (fork the engine).

Decisions worth locking:

Want to dig into the Mac launcher design, the OrbStack-specific integration details, the VS Code Remote file-handoff story, or the WSL2 onboarding polish?

```scheme
(version 1)
(deny default)
(allow file-read* (subpath "/rts/zones/alpha"))
(allow file-write* (subpath "/rts/zones/alpha/workspace"))
(allow network-outbound (remote ip))
(allow process-fork)
...
```

- User namespaces: enabled by default on recent WSL2 kernels. If you hit issues on older versions, sudo sysctl kernel.unprivileged_userns_clone=1 fixes it.
- systemd: off by default historically, now opt-in via /etc/wsl.conf. Matters only if you choose the systemd-nspawn path; irrelevant for bubblewrap.
- Filesystem performance across the host/guest boundary: reading/writing files on the Windows side via /mnt/c/ is slow. Keep all zone contents inside the WSL2 filesystem (/home/..., /rts/...). This is a performance gotcha, not an architectural issue.
- Cgroup v2: WSL2 supports it, though it took some kernel-version flux. Modern WSL2 (2023+) is fine.
- Networking: WSL2 has its own network stack visible inside the VM. Your per-agent network namespaces behave normally. Getting traffic to Windows-host services requires the host.docker.internal-style routing, but that's only relevant if you care about Windows-side services, which you probably don't for a dev tool running inside WSL.

- Linux namespaces (mount, PID, network, user, etc.)
- cgroups
- overlayfs
- bubblewrap (no port exists and the primitives aren't there to port it to)
- bind mounts in the Linux sense (macOS has mount_nullfs on old versions, removed in newer)

- chroot (works, same limitations as Linux chroot, same escape vulnerabilities)
- sandbox_init / Seatbelt (Apple's sandbox framework, somewhat deprecated, undocumented, quirky)
- App Sandbox (for signed apps, too restrictive for your use case)
- Endpoint Security framework (for observation, not restriction; requires signed entitlement)
- DYLD interposition (library-level tricks, fragile)
- Full VMs (via Virtualization.framework on Apple Silicon, Hypervisor.framework, or third-party runtimes)

- Network isolation
- PID isolation
- Resource limits
- Clean teardown of sub-mounts (macOS chroot doesn't do namespace cleanup, because there's no namespace)

- Filesystem path isolation (agent can't navigate out by path)
- The zone-as-directory mental model
- The control-file protocol
- Everything at the application/event layer (event log, policy, map UI)

- Operator runs a small Linux VM on their Mac.
- Your engine runs inside that Linux VM.
- Agents run inside bubblewrap sandboxes inside the VM.
- The Mac is just the host; the actual work happens in Linux.

- Engine is Linux-only.
- Linux users (including WSL2) run it directly.
- Mac users run it inside a Linux VM (you provide a Lima/OrbStack recipe, or bundle a Virtualization.framework wrapper).
- One codepath, strongest semantics, lowest maintenance.
- Cost: Mac users need a VM. On Apple Silicon with OrbStack or Apple's container, this is ~30 seconds of setup and near-native performance.

- Engine abstracts over backends: bubblewrap on Linux, sandbox_init + chroot on macOS, maybe something else on BSD.
- Each backend implements the same interface: create zone, launch agent in zone, enforce policy.
- Tests run on all platforms.
- Semantics kept consistent but weaker on macOS than Linux.
- Cost: three codepaths, divergent capabilities, permanent maintenance burden on the weakest platform.

- Don't pretend to support Mac.
- Users on Mac either use WSL2 equivalent (a Linux VM they manage) or don't use the tool.
- Simplest path; narrowest audience.

1. Your engine's value is in the namespace semantics, not the platform. If you fork the engine to "do something sort of like namespaces" on macOS, you have a lesser product on a platform that your users can already run real Linux on via a VM.
2. The VM overhead on modern Macs is genuinely low. Apple Silicon + Virtualization.framework is fast enough that the VM layer is not perceptibly slow for dev workloads. OrbStack in particular boots in ~2 seconds and adds negligible overhead to filesystem and network operations.
3. Most of your users will be on Linux anyway. The developer audience for an agent-fleet orchestration tool skews hard to Linux and WSL2. Mac users are a minority, and they're used to running Linux via a VM for serious tooling.
4. Path A's Mac story is operationally clean. The Mac experience is:

Install OrbStack (or Apple container, or Lima).
container run rts-engine ... or equivalent.
Mount the operator's code directory into the VM with VirtioFS.
Everything works exactly as on Linux.

That's a tractable onboarding doc and a maintainable architecture.
5. Install OrbStack (or Apple container, or Lima).
6. container run rts-engine ... or equivalent.
7. Mount the operator's code directory into the VM with VirtioFS.
8. Everything works exactly as on Linux.
9. Path B's cost is permanent and hidden. The macOS codepath will always be weaker, always have subtle behavior differences, always need separate testing, and will be the source of bug reports that only reproduce on Macs. This is a tax you pay forever. The Mac users who care about the weaker semantics will complain; the ones who don't care would have been happy with Path A's VM.
10. Path C is too narrow. WSL2 is a huge unlock for Windows, and Linux is the natural home for this tool; but saying "sorry, no Macs" for a developer tool in 2026 is a real hit to reach. Path A gets you Mac support with ~0 extra engineering.

- Install OrbStack (or Apple container, or Lima).
- container run rts-engine ... or equivalent.
- Mount the operator's code directory into the VM with VirtioFS.
- Everything works exactly as on Linux.

- Engine (Rust): Linux-only. Uses bubblewrap, namespaces, cgroups, overlayfs. This is "the real product."
- Web UI: browser-based, platform-independent. Served by the engine.
- CLI: platform-independent thin client that talks to the engine over a Unix socket or HTTP. Runs wherever the user is, including on the Mac host (to open a browser, show desktop notifications, hand off to open for files, etc.).
- Mac launcher (optional, small): a Swift or Rust tool that:

Detects OrbStack/Lima/Docker Desktop/Apple container
Launches the engine VM if not running
Exposes the engine's socket to the host
Registers URI handlers (for rts://... URLs to open in the browser)
Handles the "click a file → open in Mac-native editor" handoff by sharing paths between VM and host via VirtioFS
- Detects OrbStack/Lima/Docker Desktop/Apple container
- Launches the engine VM if not running
- Exposes the engine's socket to the host
- Registers URI handlers (for rts://... URLs to open in the browser)
- Handles the "click a file → open in Mac-native editor" handoff by sharing paths between VM and host via VirtioFS

- Detects OrbStack/Lima/Docker Desktop/Apple container
- Launches the engine VM if not running
- Exposes the engine's socket to the host
- Registers URI handlers (for rts://... URLs to open in the browser)
- Handles the "click a file → open in Mac-native editor" handoff by sharing paths between VM and host via VirtioFS

- VirtioFS shared folder (OrbStack, Lima, Apple container all support it). The operator's ~/rts-workspace on the Mac is mounted into the VM. Files are visible and editable from both sides. Performance is good on Apple Silicon, acceptable elsewhere.
- VS Code Remote: VS Code's "Remote - WSL/SSH/Containers" extensions transparently connect to the VM. File editing happens "on the Mac" from the UX perspective, while the files live in the VM.
- SSHFS: classic. Works. Slower than VirtioFS.

1. Build engine on Linux. This covers native Linux and WSL2.
2. Recommend OrbStack or Apple's container CLI for Mac users. Document the setup.
3. Optionally, a small Mac-native companion app that automates VM setup and does file/URI handoff.
4. Accept that Mac users have one extra step. This is normal for tools in this category.

1. Mac via OrbStack/Apple-container/Lima/Docker Desktop: I'd build for OrbStack first (best UX) and Apple container second (Apple's sanctioned path), document others as "should work."
2. Mac launcher scope: nothing (users SSH into VM), lightweight (auto-starts VM + URI handler), or full (native tray app with controls)?
3. File-handoff mechanism: VirtioFS by default, VS Code Remote as the recommended editor integration?
4. WSL2 onboarding script: yes or no? I'd argue yes, it makes first-run much smoother.


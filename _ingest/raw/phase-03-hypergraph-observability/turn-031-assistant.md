---
turn_id: 031
merged_turn_id: 022
role: assistant
phase: 03-hypergraph-observability
source_lines: [1946, 2190]
source_sha256: f2ecbe2152ca9f64048f175c921ee0db31f4f70328ae5867123e4528dc6bbe93
char_count: 18930
---



## Assistant

Good simplification. `chroot` is the boring, obvious version of what I was overcomplicating with mount namespaces and Plan 9 aesthetics, and for your use case it's probably the right call. Let me work through what changes and what you should actually know before committing.

The core thing you need is: each agent should only see its zone, and attempting to access anything outside should fail at the OS level, not at a hook layer that could be bypassed or miscoded.

`chroot` gives you exactly that with one syscall. The agent process sees its chroot directory as `/`. Paths outside are unreachable — not "forbidden," but literally non-existent from the agent's perspective. Zone violation becomes a file-not-found error, which is the cleanest possible failure mode because the agent's tool frameworks already handle it gracefully.

No mount namespaces, no FUSE, no 9P server, no per-process namespace graph. Just: `chroot("/rts/zones/alpha")`, `exec("claude")`, done.

This also dodges a bunch of complexity I was waving at:

The result: the zone is the agent's filesystem root. "Transfer file between zones" is `cp` or `mv` between two chroot directories. "Share file" is a hard link. "Fence" is a narrower chroot. Zone membership is `ls`.

Worth being clear-eyed, because chroot has well-known limitations:

It gives you:

It doesn't give you:

For your use case — friendly coding agents you're running yourself, not adversarial untrusted code — most of these don't matter. The agents aren't trying to escape; you just want zone structure to be enforced so that the permission model is real. Chroot handles that.

If you later want stronger isolation: containers (Docker, Podman, systemd-nspawn) are "chroot plus more namespaces" and you can upgrade without changing the conceptual model. The agent still sees `/` as its zone; the container just also isolates network, PIDs, etc.

The engine is the thing that sets up, populates, and tears down chroots per agent. Responsibilities:

Chroot setup. Given a zone spec, create a directory tree at `/rts/zones/<agent>/` and populate it with what the agent needs:

Agent launch inside the chroot. Spawn the agent process, `chroot` into the zone, drop to a non-root UID, exec the agent binary. The agent lives inside.

Zone operations as filesystem operations. Transfer, share, fence, merge, split — all become `cp`/`mv`/`ln`/`rm` operations on the chroot directories. The operator's UI actions translate to these.

Teardown. On agent exit, optionally snapshot the zone (for replay/audit), clean up the chroot.

Shared substrate management. There's one "commons" or "shared" directory that gets bind-mounted into multiple zones as needed. This is the `~shared` region from the previous turn, realized as a real directory you control.

This is the first thing that bites. A chroot directory needs enough inside it for the agent to run. For a Node-based CLI like Claude Code or OpenCode, this means Node itself, its dependencies, system libraries, CA certs, DNS resolution, etc. Naive chroot setup means copying or bind-mounting all of this.

Three approaches, ordered by laziness:

Option A: Bind-mount the host. The chroot contains bind mounts of `/usr`, `/lib`, `/lib64`, `/etc`, `/bin` (read-only) from the host. The agent uses host binaries and libraries. Zone contents (the agent's writable workspace) are a separate subtree that's genuinely per-zone.

Pros: trivial setup, works with whatever the host has installed, no duplication.
Cons: agent can read host system files. That's fine for your trust model but worth acknowledging — the zone is "the agent's workspace is isolated, the system is shared."

Option B: Build a minimal rootfs. Use debootstrap, alpine's apk, or a static-linked tarball to construct a small rootfs tree, copy it into each zone. Agent has its own system view.

Pros: genuinely isolated, reproducible, snapshotable.
Cons: disk cost per zone, more setup work, version drift between host and chroot.

Option C: Use overlayfs. Lower layer is a shared base rootfs (constructed once). Upper layer is per-agent writable overlay containing just the zone contents. Agent sees a merged view; its writes go to its own upper.

Pros: shared storage, per-agent mutations, trivially snapshotable (the upper layer is the agent's changes).
Cons: Linux-specific, slightly more complex setup.

Recommendation: A for v1, C for v2. Bind-mount the host for the first build because it's ten lines of setup code and gets you running. Migrate to overlayfs when you want proper snapshots and reproducibility.

Within the chroot, the agent has a workspace — the files it's allowed to edit, create, and call its own. Structurally:

The agent sees `/` and inside it `workspace/`, `shared/`, `control/`. Its world is simple. The operator's UI provides views into any of these, but underneath it's just files.

With this model, every zone operation from earlier turns gets a one-line implementation:

All of these are visible to the operator as "moving files around on a map." The map view is a rendering of the chroot filesystem layout. Drag a file from zone A to zone B → `mv`. Right-click → "share with beta" → `ln`. No abstraction layer between the UI and the filesystem.

The policy file lives inside the chroot at `/control/policy` (readable by the agent, writable by the RTS). But — critically — with chroot, the policy is mostly redundant for filesystem operations. The chroot itself is the policy: the agent can only touch what's in its chroot. The policy file then serves a narrower role:

This is a cleaner separation: filesystem enforcement is OS-level via chroot, semantic enforcement is policy-file-level via hooks. Two layers, each doing what it's best at, no overlap.

Chroot doesn't isolate network. The agent can still hit any URL. For your use case this might be fine — if agents should be able to call services, let them — but you probably want some control.

Options:

For v1, I'd go with accept it, log everything (the agent's tool-call stream already tells you what URLs it hit). If you need enforcement later, the proxy approach is usually the right trade.

The process-attribution problem from several turns ago (fanotify, eBPF, etc.) substantially dissolves under chroot. Because:

You still want process-tree tracking for shell-outs inside the chroot (agent runs `grep`, you want to know what `grep` touched), but cross-agent attribution is essentially free. The `pwd` of a process tells you the zone. That's much simpler than the PID-correlation dance.

The engine is a small Rust library. The launcher is a short supervised-subprocess routine. Everything else (map, policy, event log) already exists from earlier turns; chroot just becomes the thing that makes the zone structural.

One thing worth saying plainly: chroot is not a security boundary. It's a structural convenience. A sufficiently determined or malicious process can escape it, especially if it runs as root inside the chroot. Known escapes exist; it's not a sandbox in the sense that seccomp or gVisor is.

For your use case (running LLM coding agents you control, that aren't trying to escape), this is fine. They're not trying to hack out. The chroot makes zone violation impossible by construction in the normal operation case, which is what you need.

If you ever want to run untrusted agents (third-party, adversarial red-team, etc.), upgrade to containers (Podman with rootless + user namespaces is the modern clean answer) or microVMs (Firecracker). The conceptual model stays the same — the agent sees its zone as `/` — so the upgrade path doesn't churn your architecture.

Comparing against the Plan 9 / namespace version:

About two-thirds of the Plan 9 aesthetic gone. The remaining third — "everything the agent sees is a file, including its control surface" — preserved, because that's the genuinely useful part. Plan 9's insight "treat interfaces as files" still applies to the control directory inside the chroot; you just don't need Plan 9's global namespace infrastructure to realize it.

The Urbit bits (event log, stable identity, state-as-function-of-log) are orthogonal to chroot and should stay. Those were about how state evolves, not about the filesystem structure.

Same two-week budget, simpler:

Week 1: chroot engine + one agent.

Week 2: zone operations + second agent.

End state: two isolated agents, file-level zone enforcement, live operator control, zone operations working. That's a credible demo and a defensible architecture.

Chroot is the right call. It's the OS's built-in "zone of control," and using it instead of inventing a higher-level namespace abstraction makes everything more concrete:

You lose Plan 9's composability (union mounts, per-process namespaces that can diverge arbitrarily) and Urbit's universal identity scheme, but you keep the useful philosophical commitments (files as interfaces, namespace-as-structure, event log as history) and you build on kernel primitives that have been stable for decades.

The engine is a weekend's worth of Rust for the core, a week for polish, and it slots cleanly into the rest of the architecture. Everything from earlier turns (VegaFusion dataflow, SIDC-style agent symbols, map visualization, 3D projection, ACP/Claude Code/OpenCode integrations, event log) stays intact — chroot just replaces the more elaborate namespace mechanism I was reaching for.

Decisions worth making before building:

Want to work through the chroot engine's Rust API, the launcher's privilege-dropping sequence, the control-file protocol (what files and what formats), or the bind-mount recipe for Node-based agents?

```javascript
/rts/zones/alpha/              <- chroot root
├── bin -> host /bin           (bind mount, ro)
├── lib -> host /lib           (bind mount, ro)
├── usr -> host /usr           (bind mount, ro)
├── etc/                       (partial copy + /etc/resolv.conf, /etc/ssl/certs)
├── tmp/                       (writable, agent-private)
├── proc/                      (bind mount or not, depending on isolation needs)
├── workspace/                 <- the actual zone contents
│   ├── project/               <- the code the agent is working on
│   └── ...
├── shared/                    <- shared substrate, bind-mounted
│   ├── libs/
│   └── services/
└── control/                   <- RTS-writable, agent-readable
    ├── prompt                 (file the operator writes messages to)
    ├── policy                 (current zone policy, live-readable)
    └── events                 (agent writes events here; RTS tails)
```

```javascript
┌───────────────────────────────────────────────────────────┐
│ Chroot Engine (Rust)                                      │
│                                                           │
│  ZoneSpec → create chroot tree                            │
│           → bind-mount host runtime                       │
│           → bind-mount shared substrate                   │
│           → populate control files                        │
│           → return ready-to-launch zone                   │
│                                                           │
│  ZoneOp (transfer, share, fence, etc.)                    │
│           → filesystem operations                         │
│           → emit event to log                             │
│                                                           │
│  ZoneTeardown → optionally snapshot                       │
│               → unmount                                   │
│               → remove tree                               │
└──────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│ Launcher                                                  │
│                                                           │
│  fork → setuid (non-root) → chroot → chdir → exec(agent)  │
│                                                           │
│  Captures stdio; plumbs control files into agent's env    │
└──────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│ Agent Process                                             │
│                                                           │
│  Sees /workspace, /shared, /control                       │
│  Emits events via SDK hook or stdio parsing               │
│  Reads prompt file for operator messages                  │
└───────────────────────────────────────────────────────────┘
```

- No namespace syscalls (which are Linux-specific and require CAP_SYS_ADMIN or user namespaces)
- No custom filesystem code
- No synthesizing interfaces as files (you can still do this later, but it's not load-bearing now)
- Works on any Unix — macOS, *BSD, Linux all have chroot

- Filesystem isolation at the path level
- Cross-platform support (POSIX)
- No special privileges needed beyond root at setup time (you can drop privileges after chroot)
- Trivial mental model — the agent's world is a directory

- Network isolation (agent can still reach any network resource)
- PID isolation (agent sees all host processes in /proc if /proc is mounted in its chroot, none if it isn't)
- Resource limits (CPU, memory, disk)
- Protection against root escapes (a root process inside a chroot can escape; well-known attack)
- IPC isolation (System V IPC, abstract Unix sockets still shared)

- The agent's own working files (its zone contents)
- Minimal runtime: /bin, /lib, /usr/lib, /etc/ssl/certs, etc. — enough for the agent CLI to execute
- Any shared objects bind-mounted in (for the "share" operation)
- A temporary writable area (/tmp)

- Transfer file from zone A to zone B: mv /rts/zones/alpha/workspace/foo.py /rts/zones/beta/workspace/foo.py. Agent A sees the file disappear; agent B sees it appear.
- Share file between zones: ln /rts/shared/foo.py /rts/zones/alpha/workspace/foo.py && ln /rts/shared/foo.py /rts/zones/beta/workspace/foo.py. Both agents see the same inode; writes from either are visible to both.
- Fence: remove subtrees from the chroot. What's not in the chroot doesn't exist.
- Merge zones: combine the chroot contents of A and B into one.
- Split zone: create a new zone, move a subset of files.
- Snapshot: cp -r (or btrfs snapshot if available) of the zone's writable portion.
- Rollback: restore from snapshot.

- Network and service restrictions (still not enforced by chroot, so policy decides what hostnames are allowed)
- Intent declaration (the agent's current task, its scope, what it's allowed to do within its chroot)
- Tool-level permissions (e.g., "no rm -rf, no git push") — still hook-enforced at the SDK layer

- Accept it. Agents can hit the network. The zone is filesystem-only. Name this openly.
- Network namespace (Linux-specific, adds kernel namespace complexity). Each zone gets its own network namespace with a whitelist of allowed endpoints. This is real containerization territory.
- Proxy-based. Run a local HTTP proxy that the agent's environment variables point to; the proxy enforces allowed destinations. Works cross-platform, gives you observability for free (you see every service call).
- DNS-based. Custom /etc/resolv.conf inside the chroot pointing to a DNS server you control, which refuses to resolve disallowed hostnames. Weaker but very simple.

- Agent A runs inside /rts/zones/alpha/. Any filesystem event whose path starts with that is attributed to A.
- The chroot guarantees the agent can't write to paths outside its zone, so there's no attribution ambiguity to resolve for writes.
- For reads, the agent can only read what's mounted into its chroot, so reads are also attributable by path.

- Rust crate that creates a chroot directory, bind-mounts host /usr, /bin, /lib, etc., creates workspace/ from a source directory, creates control/ with prompt, policy, events files.
- Launcher forks, drops privileges, chroots, execs Claude Code with its permission hooks pointing to a URL on the RTS (or writing to the control/events file).
- RTS tails events, sees tool calls, renders them as edges on the map.
- Operator writes to prompt file → agent receives it as a user message.

- Implement transfer, share, fence as RTS commands that do filesystem operations on the chroot trees.
- Add a second agent (OpenCode via ACP, or another Claude Code instance) in its own chroot.
- Test sharing: a file hard-linked into both chroots, edits from either visible to both.
- Test transfer: map drag → mv → both agents' views update.
- Validate that the two agents are genuinely isolated: agent A has no path to agent B's workspace.

1. Host runtime drift. Bind-mounting /usr means agents get whatever system libraries you have. If you update your host libc, agent behavior might change. Option C (overlayfs with a frozen base) fixes this but adds complexity. For a personal tool, not a problem; for anything reproducible, a real issue.
2. /proc and /dev handling. Many tools break without these. You probably need /proc mounted (bind or fresh) and a minimal /dev (just /dev/null, /dev/urandom, /dev/tty). Getting this minimal-but-complete is fiddly the first time.
3. Agent CLIs that phone home or write to unexpected paths. Node-based agents often want ~/.npm, ~/.cache, etc. In a chroot, $HOME is wherever you point it (typically /workspace or /tmp). You may need to set env vars carefully. Expect to iterate on what the agent needs.
4. Auth tokens and secrets. The agent needs API keys to reach Anthropic/OpenAI. These go in the chroot via env vars (simplest) or a mounted secrets file. Be careful about what leaks into the zone.
5. Root required for setup. chroot needs root (or CAP_SYS_CHROOT). The engine either runs as root and drops privileges per agent, or runs as a user with the capability granted. For a personal tool, running a privileged launcher is fine; for a shared service, use a setuid helper or a systemd unit with capabilities.
6. Cross-platform story weakens. chroot exists on macOS and BSD, but the bind-mount-the-host trick is Linux-idiomatic. On macOS, you'd need to copy files or use different tricks. Still buildable, just different. If Linux-first is acceptable, chroot is fine.

- Zones are directories.
- Zone operations are file operations.
- Policy is a file.
- Control is a file.
- Events are a file.
- The agent's reality is /, which is the zone.
- The map is a view over the chroot filesystem.

1. Host bind-mounting vs. minimal rootfs vs. overlayfs — I'd start with host bind-mounting.
2. Root-owned launcher or user-level with capabilities — probably root launcher for simplicity, drop privileges before exec.
3. Network policy — accept for v1, proxy later.
4. /proc and /dev setup — research the minimum once, codify it.
5. Snapshot strategy — does v1 have snapshots at all, or is that a later feature?


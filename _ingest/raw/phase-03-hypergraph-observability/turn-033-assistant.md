---
turn_id: 033
merged_turn_id: 024
role: assistant
phase: 03-hypergraph-observability
source_lines: [2197, 2485]
source_sha256: cde03fa158afea0b5796a0806be1b95543612aa9b4f13bca6fbb7aa800452655
char_count: 18651
---



## Assistant

Yes — several, and they form a clear ladder. "Fancier chroot" is actually one of the most well-explored territories in Linux systems engineering, because chroot's limitations have been known for decades and every subsequent isolation primitive is some variation on "chroot plus more." Let me walk the ladder, because picking the right rung matters more than people usually think.

Each step adds specific isolation dimensions while preserving the "agent sees its zone as /" mental model.

Strictly more capable than `chroot`, barely more complex. `pivot_root` swaps the root filesystem of a mount namespace, rather than just changing the current process's idea of where `/` is. Key differences:

If you want "chroot but without the well-known escapes," `pivot_root` inside an unshared mount namespace is the minimum upgrade. It's 20 lines of Rust more than plain chroot. No new concepts, just better primitives.

When to pick it: if plain chroot is your instinct, do this instead. It's strictly better, and the mental model is identical.

This is where "fancier chroot" actually starts paying for itself. Linux has seven namespaces you can unshare per-process:

Put these together and you have a real isolation model. This is what containers actually are under the hood — there's no container kernel primitive; "container" is just a marketing term for "a process with several namespaces unshared and its root pivot_rooted into an isolated filesystem."

The Rust path: `nix::sched::unshare`, `nix::sched::clone`, or `nix::sched::CloneFlags`. Direct syscalls, no runtime dependency. A small Rust crate can be the "make a container from scratch" layer, and that's closer to your style than pulling in Docker.

When to pick it: when you want real per-agent isolation (network rules, PID tree, resource limits) but don't want to adopt a container runtime. You're writing ~200 lines of Rust instead of 20, but you've built your own minimal container engine that does exactly what you need and nothing else. For your project, this is probably the right rung.

A small, focused C tool (used under the hood by Flatpak) that exposes Linux namespaces through a clean command-line interface. Think of it as "namespaces, but you describe the sandbox as CLI args."

That's it. Full per-agent isolation, declaratively specified, no runtime required beyond bubblewrap itself. Mount bind, ro-bind, tmpfs, namespace unsharing, all via flags.

Pros: battle-tested (Flatpak relies on it), small (one static binary), stable CLI, very fast startup (< 10ms overhead), designed exactly for your use case ("run this program in a constrained filesystem environment").
Cons: external dependency, not Rust-native, Linux-only.

When to pick it: when you want the Rung 2 benefits without writing the kernel-call Rust. Shell out to `bwrap` from your Rust engine; let it do the namespace setup; your engine's job becomes "generate the bwrap invocation and supervise the process." This is probably the fastest path to a working fancy-chroot for your project.

The specific reason bubblewrap is compelling for you: the whole agent-zone spec becomes a config file that generates a bwrap command line, which means your zone policy is a declarative thing you can inspect, edit, diff, and version-control as text. That's a nice property.

systemd's built-in lightweight container runner. Not a daemon, just a command. Sets up all the namespaces, populates `/dev`, manages cgroups via systemd, handles the chroot/pivot_root, gives you a shell or runs a process in the container.

Also ~one line. More "complete" than bubblewrap in that it sets up a fuller Linux userland (getty, init-like behavior if desired) but also heavier. Integrates with systemd's cgroup management for free.

Pros: no extra install on systemd distros, integrates with `systemctl` for lifecycle, excellent cgroup integration.
Cons: systemd-dependent, overkill if you just want process isolation (it thinks in terms of "containers as tiny machines"), logs via journald which you may or may not want.

When to pick it: if your host is a systemd distro and you want the containers to feel like proper managed services. Less idiomatic for "launch-a-process-in-a-sandbox" than bubblewrap.

Full container runtimes. You know these. For your use case they're almost certainly overkill:

When to pick it: if you specifically want OCI images (so you can distribute pre-built agent environments), or if you want to share infrastructure with an existing containerized platform. Podman's rootless mode is genuinely nice. But for "launch an agent with filesystem and network isolation," you're paying a lot for capabilities you don't need.

Podman is the less-bad option here because it's daemonless and works well rootless. Docker's daemon model is more friction than it's worth for this project.

The "real" sandbox tier. These provide actual security boundaries against malicious code:

When to pick it: only if you're running adversarial agents — third-party agents, red-team agents, agents you don't control. For agents you write and run yourself, this is paranoia.

Your instinct is right, and it's important to pin down why it's right, because it tells you which rung to pick:

The friendly coding agents you're integrating (Claude Code, OpenCode, OpenClaw) are not trying to escape. They're trying to do their job. You're not defending against malicious code; you're imposing a structural model so that zone semantics are real.

This means:

So: you want Rung 2 or Rung 3. Namespaces, not containers, not VMs.

Here's why bubblewrap specifically:

which compiles to a `bwrap ...` command. Zone policy becomes text, which means it's diffable, version-controllable, and introspectable.

The path looks like:

Minimal changes. Everything I said about chroot still applies:

The delta is:

Concrete things that work better with namespaces:

Each of these is a real quality-of-life improvement over chroot, and they come essentially free with bubblewrap.

Network namespace setup is where complexity lives. If you want the agent to reach the internet (to call Anthropic/OpenAI APIs), you need to either:

For v1, I'd actually share the host network namespace (accept weaker network isolation) and apply policy via an HTTP proxy the agent's env points to. That's the pragmatic path. Later you can upgrade to slirp4netns for proper per-agent net namespaces.

User namespaces can surprise you. If the agent needs to write files that end up readable by the host user (and it does — those files are in `workspace/` which the operator and other tools access), UID mapping matters. The default mapping (agent's UID 0 = host's UID X) usually does what you want, but edge cases exist. Test early.

Bubblewrap setuid requirement. On some distros, bubblewrap needs to be setuid-root to unshare user namespaces. On others, unprivileged user namespaces are enabled by default. Check your target distro. Not a blocker but worth knowing.

Overlayfs as the filesystem is a natural fit. Lower layer = the base rootfs (shared, read-only, built once). Middle layer(s) = shared substrate between agents. Upper layer = per-agent writable workspace. Bubblewrap supports overlayfs via `--overlay-src` and `--overlay` flags. This gets you copy-on-write semantics, snapshots for free (the upper layer is the snapshot), and storage efficiency.

Chroot was Rung 0 (ish). Plain chroot worked but with escape risk and no process/network/resource isolation.

Bubblewrap is Rung 3. Full namespace isolation, minimal setup effort, declarative zone specs, correct semantics for your use case.

You skip Rungs 4+ (container runtimes, VMs) because you don't need image management, you don't need hardware virtualization, and you don't have adversarial agents.

You could go to Rung 2 (direct namespace syscalls in Rust) for purity and zero external dependency. I'd argue this is premature optimization — bubblewrap is small, fast, and the dependency is trivial. But if you want to drop it eventually, the port is straightforward.

That's essentially the whole engine. A few hundred lines to polish, but the shape is this.

Keep:

Skip:

"Fancier chroot" has a good answer, and that answer is "Linux namespaces, accessed through bubblewrap." This is a well-trodden path — Flatpak, the Steam Runtime, a bunch of CI sandboxes, and a lot of single-purpose sandbox tools all use bubblewrap for exactly this kind of "run this process in an isolated filesystem + some namespace isolation" use case. You'd be building on well-validated infrastructure.

The key insight: you don't need containers, and you don't need to roll your own namespace code. You need bubblewrap, and your engine wraps it. That's the Goldilocks zone for this project.

Decisions worth locking:

Want to dig into the bubblewrap invocation details for Claude Code / OpenCode specifically, the overlayfs layout, the event-log-through-control-files protocol, or the network proxy design?

```javascript
bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --bind ./agent-alpha-workspace /workspace \
  --bind ./shared-substrate /shared \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --unshare-pid --unshare-net \
  --chdir /workspace \
  claude
```

```javascript
systemd-nspawn -D /rts/zones/alpha --bind=/shared --private-network claude
```

```rust
struct ZoneSpec {
       workspace: PathBuf,
       shared: Vec<PathBuf>,
       ro_host_paths: Vec<PathBuf>,  // /usr, /lib, etc.
       network: NetworkPolicy,
       env: HashMap<String, String>,
       command: Vec<String>,
   }
```

```javascript
Zone policy (text config)
   │
   ▼
ZoneSpec (Rust struct)
   │
   ▼
bubblewrap invocation (CLI args)
   │
   ▼
bwrap fork/execs agent inside namespaces
   │
   ▼
Agent sees: /workspace, /shared, /control, minimal / otherwise
```

```rust
struct ChrootEngine {
    zones_root: PathBuf,
    shared_root: PathBuf,
    base_rootfs: BaseRootFs,  // bind-mounts or overlay lower
}

struct Zone {
    id: ZoneId,
    workspace: PathBuf,
    shared_mounts: Vec<PathBuf>,
    policy: PolicyRef,
}

impl ChrootEngine {
    fn create_zone(&self, spec: ZoneSpec) -> Zone { ... }
    
    fn launch(&self, zone: &Zone, command: &[&str]) -> LaunchedAgent {
        let args = self.build_bwrap_args(zone, command);
        let child = Command::new("bwrap").args(&args).spawn()?;
        LaunchedAgent { child, zone_id: zone.id }
    }
    
    fn transfer(&self, from: &Zone, to: &Zone, path: &Path) { ... }  // mv
    fn share(&self, zones: &[&Zone], path: &Path) { ... }  // ln
    fn snapshot(&self, zone: &Zone) -> Snapshot { ... }
    fn teardown(&self, zone: Zone) { ... }
}

fn build_bwrap_args(zone: &Zone, command: &[&str]) -> Vec<String> {
    let mut args = vec![
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/etc/ssl", "/etc/ssl",
        "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--bind", zone.workspace.display(), "/workspace",
        "--unshare-pid",
        "--unshare-uts",
        "--unshare-ipc",
        "--chdir", "/workspace",
        "--die-with-parent",
    ];
    for shared in &zone.shared_mounts {
        args.extend(["--bind", shared.display(), "/shared"]);
    }
    args.extend(command);
    args
}
```

- Works inside a mount namespace, so the old root can be unmounted and fully detached. With chroot, the old root is still there, just not reachable by path — which is the basis of most chroot escapes.
- Designed for container-like scenarios.
- Used by essentially every container runtime as the actual "chroot step."

- Mount: each process sees its own filesystem tree, with independent bind mounts. This is the big one — lets you bind-mount things into the agent's view without affecting the host, and cleanly tear down on exit.
- PID: agent sees only its own process subtree. Its ps aux shows only its children. PID 1 inside the namespace is the agent itself.
- Network: agent gets its own network stack — separate interfaces, routing tables, firewall rules. You can whitelist outbound destinations at the kernel level.
- UTS: agent has its own hostname.
- IPC: System V IPC / POSIX message queues are separate.
- User: UIDs can be remapped — agent can be "root" inside its namespace while being a low-privilege user outside. Enables rootless setup.
- Cgroup: CPU, memory, I/O accounting and limits per agent.

- You get image management, registries, networking stacks, volume management, orchestration hooks, etc.
- But also: a daemon (Docker) or more machinery (Podman, containerd), image layer abstractions you don't need (you're bind-mounting the host), OCI-spec overhead, and the cultural weight of "I'm running containers" which pulls people toward Kubernetes.

- gVisor: intercepts syscalls in userspace, reimplementing the kernel API. Agent can't directly reach the host kernel.
- Kata Containers: runs each container in a lightweight VM.
- Firecracker: microVMs, originally for AWS Lambda. Very fast boot (hundreds of ms), proper hardware virtualization.

- You don't need gVisor/Firecracker tier. Security isolation isn't the goal.
- You don't need container-runtime tier (Docker/Podman). Image management and orchestration aren't the goal.
- You do benefit from namespace-tier isolation, because:

Network namespace lets you apply per-agent network policy properly (each agent has its own iptables-equivalent and can't cheat).
PID namespace makes the agent's process tree clean and attributable.
Mount namespace gives you clean bind-mount teardown and overlayfs per agent.
User namespace lets you run unprivileged but have the agent think it's root (some tools need this).
Cgroup namespace lets you account for and limit agent resource use.
- Network namespace lets you apply per-agent network policy properly (each agent has its own iptables-equivalent and can't cheat).
- PID namespace makes the agent's process tree clean and attributable.
- Mount namespace gives you clean bind-mount teardown and overlayfs per agent.
- User namespace lets you run unprivileged but have the agent think it's root (some tools need this).
- Cgroup namespace lets you account for and limit agent resource use.

- Network namespace lets you apply per-agent network policy properly (each agent has its own iptables-equivalent and can't cheat).
- PID namespace makes the agent's process tree clean and attributable.
- Mount namespace gives you clean bind-mount teardown and overlayfs per agent.
- User namespace lets you run unprivileged but have the agent think it's root (some tools need this).
- Cgroup namespace lets you account for and limit agent resource use.

1. Your engine shrinks. Instead of writing the namespace-setup logic in Rust with nix crate calls, you generate a bubblewrap command line from your zone spec. Your Rust engine's job becomes "policy → bwrap args → fork/exec bwrap → supervise." A few hundred lines at most.
2. Zone spec is declarative. A zone becomes a struct like:

1. Zone operations stay trivially filesystem-based. Transfer, share, fence are still mv, ln, rm on the host-visible paths. Bubblewrap just bind-mounts them into the agent's view.
2. You can upgrade to Rung 2 later without architectural change. If you decide you want the namespace-setup logic in-process (to avoid shelling out, or for per-agent programmatic customization), you port the bubblewrap invocation logic to nix::sched::unshare calls. The zone spec doesn't change; only the executor does.
3. It's actively maintained by serious people. The containers/Flatpak folks stress-test it. You benefit.

- Zones are directories (host-visible) that get bind-mounted into agents
- Zone operations are filesystem operations
- Policy is a file
- Control surface is files in /control/
- Event log, map view, etc. all unchanged

- Launch path uses bwrap instead of chroot
- Agents get PID/network/mount/IPC/user namespaces in addition to filesystem root isolation
- Network policy becomes real (per-agent net namespace, with explicit bridge/veth or a proxy forced via iptables rules in the namespace)
- Resource limits become real (cgroups per agent, configurable from your engine)

- ps inside the agent shows only its processes. This is clarifying for the agent's self-model and closes a surprising information leak.
- Network policy is enforceable. You can run iptables rules inside the agent's net namespace, or give it a veth pair routed through a host-side proxy. Agent can't bypass.
- Per-agent /tmp. A fresh tmpfs per zone, gone on teardown. No leak between agents.
- Resource limits. CPU/memory caps via cgroups mean a runaway agent doesn't take down the host.
- Clean teardown. Unmount the namespace, everything inside goes away atomically. No leftover processes, no leftover bind mounts, no leftover anything.
- User namespace support. Agent can run as UID 0 inside its namespace (some tools really want this) while actually being an unprivileged UID outside. Rootless-capable.

- Share the host network namespace (--share-net in bubblewrap) — simplest, but loses the isolation benefit for network.
- Set up a veth pair, give the agent one end, configure routing on the host — full isolation, more setup.
- Use a slirp-style userspace networking (slirp4netns) — no root needed on host, agent gets its own netns with NAT'd access. Simpler than veth.

- Everything from the previous turns: Arrow event log, VegaFusion dataflow, map rendering, SIDC symbols, zone operations as filesystem operations, ACP adapter, Claude Code integration, OpenCode integration.
- The "control files" concept: /control/prompt, /control/policy, /control/events. These work the same inside a bwrap sandbox as they did inside a chroot.

- Writing Plan 9 mount-namespace logic by hand in Rust (bubblewrap does it).
- FUSE for synthesizing interfaces (real files still work).
- 9P server (not needed).
- Container runtime integration (bubblewrap is the runtime).
- Custom image management (host bind-mounts + overlayfs handle it).

1. Bubblewrap shell-out or Rust nix::sched::unshare? I'd argue bubblewrap for v1, port to native syscalls only if you have a specific reason.
2. Network policy: share host net for v1 + proxy, or full net-namespace from day one?
3. Overlayfs or bind-mount-based rootfs: overlayfs is cleaner but adds a wrinkle; bind-mounts are trivial.
4. Rootless or root launcher: bubblewrap supports both; rootless is slightly more fiddly but much better security posture.
5. Cgroup management: systemd user slices, manual cgroup v2, or skip resource limits for v1?


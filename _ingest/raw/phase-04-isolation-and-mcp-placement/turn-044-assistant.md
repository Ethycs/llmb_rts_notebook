---
turn_id: 044
merged_turn_id: 032
role: assistant
phase: 04-isolation-and-mcp-placement
source_lines: [3080, 3320]
source_sha256: 18643aac1cc1f811ceeddfc76163164c09bd9f67eb4e59b7e2ea7218cf3c5031
char_count: 20941
---



## Assistant

Yes — SSH is actually a very good fit here, and it's underused as a namespace bridge even though that's exactly what it was built to be. The reason it works for cross-domain stuff in your architecture is that SSH already solves the same problems you'd otherwise solve from scratch: authenticated identity, multiplexed channels, port and stream forwarding, agent forwarding, cross-machine process control. You're getting a battle-tested control plane for free if you use it as the substrate rather than something you bolt on later.

Let me work through where SSH fits, what it does well, where it's not the right answer, and what the architecture looks like with it as a first-class citizen.

Worth being precise because "cross-domain" can mean several things and SSH addresses them differently:

Each is a different problem; SSH solves 2, 3, and 5 cleanly, helps with 4, and is wrong for 1. Let me take them in order.

This is the strongest case. If your RTS engine and the agents it controls are on a different machine than the operator (which they often will be — beefier hardware, persistent uptime, separation of dev laptop from work environment), SSH is the right transport for everything that needs to cross machines.

Specifically:

Operator's magic CLI talks to a remote daemon. Instead of a local Unix socket, the CLI's transport is SSH:

becomes, transparently:

with appropriate key-based auth and connection multiplexing. The user types the same thing; the daemon happens to be remote. With SSH ControlMaster (persistent connection multiplexing), per-command latency drops to ~10ms — comparable to a local Unix socket for many purposes. For interactive shells (`magic alpha bash`), latency is essentially imperceptible on a LAN.

Cross-machine zone access. A zone can live on whichever host its agent runs on. The operator's CLI doesn't care; it dispatches `magic <zone> <cmd>` to the right host based on where that zone is registered. Multi-host RTS becomes natural rather than retrofitted.

Web UI over SSH tunnel. The map UI runs on the daemon's host; the operator accesses it via `ssh -L 8080:localhost:8080 workstation` or, more elegantly, ProxyJump or `RemoteForward`. No need for the daemon to listen on a public port; SSH is the authenticated tunnel. This is how most serious developer tooling handles "service running on remote host, UI on local browser."

The thing that makes SSH-as-control-plane actually fast enough is `ControlMaster` (persistent connection sharing). Without it, every `magic` invocation pays a TCP handshake + TLS handshake + SSH key exchange — easily 200-500ms. With it, the first invocation pays the cost; subsequent ones reuse the existing connection at sub-10ms.

Operator's `~/.ssh/config`:

This is essentially mandatory for SSH-as-RPC to feel responsive. With it, SSH becomes a viable transport for high-frequency operations (every keystroke for an interactive command, every tab-completion query, every event-log poll).

This was the unresolved bit from the platform turn — Mac users run a Linux VM, but how does the operator interact with it? SSH is the universal answer.

OrbStack, Lima, and Apple's `container` CLI all expose SSH access to the VM out of the box. The Mac-side `magic` is literally a wrapper that SSH's into the VM and runs the real `magic` there:

With ControlMaster, this is fast. With proper `ssh_config`, it's invisible. The Mac user types `magic alpha vim foo.py` and gets vim editing a file in the Linux zone, with the editor running in the Linux VM but rendering through their terminal — which Just Works because SSH is built for this.

Even better: with X11 forwarding or a Wayland-over-RDP/VNC bridge, you can run GUI tools inside the VM if you ever want to. Probably not relevant for your use case but the capability is free.

For Mac-native editor integration:

This is the more interesting design choice. SSH gives you authenticated, fine-grained channels between principals. You can use it as the internal substrate for inter-component communication, not just operator-to-host.

Concretely: every agent gets its own SSH server inside its zone, with a constrained `authorized_keys` configuration. The RTS connects to each agent's SSH server to issue commands and receive events. Inter-agent communication, if you allow it, also goes through SSH with explicit per-pair authorization.

Each public key authorized to connect can only run a specific predetermined command. The agent's SSH server is the agent's control plane; the `command=` restrictions enforce policy at the SSH layer.

What this gets you:

This is architecturally nicer than the alternative (Unix sockets + custom auth + custom command dispatch) because every piece exists already.

The cost is operational: you're running an SSH server per agent zone, managing keys, configuring `authorized_keys`. SSH is heavier than a Unix socket. For a personal-scale RTS this is fine; for thousands of agents you'd want lighter primitives (something like an internal mTLS gRPC), but at that scale you're a different product.

You might be tempted to forward the operator's SSH agent into zones so the agents inside can themselves SSH to other places. Don't. Agent forwarding is a known security hazard (a compromised target can use your agent to authenticate to other hosts), and you don't control what your agents do with it. If an agent inside a zone needs SSH access to something, give it its own keypair stored inside the zone. This is the standard hygiene and worth being explicit about.

Beyond RPC, SSH is also a good answer for the streaming side of the architecture. The agent's tool-call event stream, an agent's stderr log, the operator's "send me everything happening in zone alpha" subscription — all are continuous streams over a long-lived connection, which SSH handles natively.

Patterns:

Event tail as ssh tail -f:

If the events file is appended to as a JSONL (or Arrow IPC) stream, this gives you the live event tap. Operator can pipe it through `jq` or whatever. The web UI does essentially the same thing under the hood, just with WebSockets instead.

Multiplex many streams: SSH can run multiple channels over one connection. The web UI's "subscribe to all zones" can be a single SSH session with N parallel `tail -f` channels rather than N separate connections.

Reverse channels: Operator's machine can expose services back to the daemon's host via `RemoteForward`. Your map UI's WebSocket might be a reverse-forwarded local port — daemon's host accesses `localhost:9090` and reaches the operator's notification listener. This is sometimes useful for "push notification to operator" without operator's host needing public reachability.

For moving data between zones across hosts, `scp` / `rsync` over SSH is the obvious answer. Less obviously useful: sshfs lets you transparently mount one zone's filesystem inside another zone's namespace, with SSH handling auth and transport.

Concretely: zone alpha needs read-only access to a directory in zone beta. Inside alpha, you `sshfs alpha-user@beta-host:/workspace/lib /shared/beta-lib`. Now alpha sees beta's `lib/` directory inside its own namespace, with SSH-enforced auth and SSH-encrypted transport. The cross-zone "share" operation generalizes from same-host hard-link to cross-host SSHFS without the rest of the architecture noticing.

Performance: SSHFS is slower than local FS but fine for read-mostly workloads. For write-heavy, you'd want NFS or 9P-over-SSH (yes, that exists) instead.

This wasn't load-bearing in earlier turns but it's worth flagging: SSH-as-substrate makes multi-operator RTS essentially free.

Two operators on different machines both want to observe and command the same zones. Without SSH, you'd build an auth system, multi-tenant API, broadcast event distribution. With SSH:

The architecture didn't need to change to support this; the substrate just supports it natively. That's the kind of property that makes SSH the right base.

Not everything should be SSH. Worth being explicit about the boundaries.

Same-host inter-zone communication: if both zones are on the same host, going through SSH is silly. Hard-linked shared directories, Unix sockets bind-mounted between zones, named pipes — these are faster and simpler. SSH only earns its keep at network boundaries.

Internal RTS daemon ↔ chroot engine: the daemon and its launcher are on the same host, in the same trust domain. They use Unix sockets and shared memory, not SSH.

High-frequency agent telemetry: tens of thousands of events per second per agent shouldn't go through SSH; the encryption overhead is wasted. Use Unix sockets or direct memory-mapped queues for the hot path; SSH for the operator-facing tap.

Web traffic from the browser to the daemon: HTTP over an SSH tunnel works but it's clumsier than just running the web UI on the same host as the daemon. The browser-to-daemon path can be plain HTTP (over loopback) with the daemon's host serving as the boundary.

Authentication for things SSH can't naturally express: capability tokens, time-limited grants, complex authorization predicates. SSH's `authorized_keys` model is great but coarse. For finer-grained things you'd use something else; just don't try to encode it all in `authorized_keys` comments.

Updating the picture from earlier turns: SSH becomes a backbone alongside (not replacing) the RTS daemon's other transports. Specifically:

Every cross-host edge is SSH. Every cross-trust-domain edge is SSH. Every operator-to-system edge is SSH. Local edges within the same host and trust domain stay on Unix sockets.

This is roughly how Kubernetes does things at the kubectl layer, how `mosh` and `tmux + ssh` do remote dev, how GitHub's Codespaces work, how every serious distributed-developer-tools product I can think of works. You'd be in good company.

SSH connection setup overhead: even with ControlMaster, the first connection of a session is slow. A daemon-side warm-pool of pre-authenticated connections can hide this. For most workflows, ControlMaster is enough.

Key management is the unsexy part of SSH-everything: who has which key, where keys live, key rotation, revocation. For personal-scale tools, SSH agents and `~/.ssh/authorized_keys` are fine. For team-scale, you want SSH certificates (signed by a CA) so you can rotate without touching every authorized_keys file. This is a real engineering investment if the tool grows.

Firewalls and NAT: cross-host SSH assumes the daemon's host is reachable from the operator's host. If they're behind separate NATs (work laptop, home server), you need a jump host or SSH reverse tunnel. Tools like Tailscale (overlay network with WireGuard, every node is reachable) often complement SSH nicely here.

Windows operators: WSL2 has SSH natively; from PowerShell, OpenSSH is now built-in on Windows 10+. Both work. The user experience is slightly less polished than on Mac/Linux but it's not a blocker.

SSH server inside agent zones is real overhead: each zone runs an `sshd`. On Linux this is small (a few MB RAM), but it's not nothing. If you have hundreds of zones, you might prefer a single SSH multiplexer that routes to per-zone Unix sockets internally. v1: per-zone sshd. v2: muxed.

Subtle SSH config gotchas: `StrictHostKeyChecking`, `UserKnownHostsFile`, `IdentitiesOnly`, `ServerAliveInterval` — these all matter for production-quality UX. `magic` should manage its SSH config or use a dedicated config file (`~/.config/rts/ssh_config`) so the user's main SSH config isn't polluted.

Logging needs care: SSH logs verbosely by default. Per-command logs from `command=` restrictions go to syslog. You probably want to capture them into your event log via journald or a parsed log forwarder. Doable but non-trivial.

The integration story: `magic` is the CLI; SSH is the transport when targets are remote. The operator types `magic alpha grep foo .`. `magic` resolves "alpha" to its zone registry entry, sees the zone is on host `workstation`, and dispatches over SSH:

For local zones, `magic` uses the Unix socket directly. For remote zones, it goes through SSH. Same UX, transport chosen based on zone location. This is the right shape — `magic` is an SSH-aware client when needed but doesn't pay the cost when not.

`magic activate alpha` plus the preexec hook from last turn: still works the same way. The hook routes commands through `magic alpha <cmd>`; if alpha is remote, those commands go over SSH automatically. The operator is unaware of locality.

The Claude Code / OpenCode / ACP adapters from earlier turns also benefit:

Remote agents: an agent process running on a remote host is just `ssh remote-host claude -p '...' --output-format stream-json`. The adapter consumes the stream over SSH the same way it consumes a local pipe. The agent's permission hooks call back via SSH (or via an HTTP callback if you prefer that for the hook protocol). Multi-host agent fleets become natural.

OpenCode's HTTP server over SSH tunnel: instead of exposing OpenCode's HTTP port on a network interface, run it on localhost in its zone and tunnel to it over SSH. The RTS daemon connects to `localhost:port` on the agent's host, which is OpenCode's localhost, accessed via SSH. No public network exposure.

ACP over SSH stdio: ACP is JSON-RPC over stdin/stdout. SSH gives you stdin/stdout. So `ssh remote-host opencode acp` is an ACP transport. The adapter doesn't care that there's an SSH layer in between; it sees a JSON-RPC stream. This is the cleanest case — SSH and ACP compose with no friction at all.

Putting it all together as a recommendation:

This gives you a tool that works locally for solo developers, scales to multi-host setups, supports macOS via Linux VMs cleanly, supports multi-operator usage when needed, and rides on infrastructure that every Unix sysadmin has been using for 25 years. The design avoids inventing custom authentication, custom transport, custom file-sync, and custom multi-host coordination — all of which are landmines.

If we updated the architecture diagram to make SSH first-class, the new edges would be:

SSH is the connective tissue. Unix sockets are the fast local path. HTTP is mostly for the web UI's browser-side. Everything else is event log, Arrow tables, and the existing internal data flow.

Want to drill into the `command=` restriction matrix for agent zones, the SSH config auto-generation story, the Tailscale-overlay multi-operator setup, or the editor integration via Remote-SSH?

```javascript
magic alpha grep foo .
```

```javascript
ssh workstation magic alpha grep foo .
```

```javascript
Host workstation
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

```bash
# /usr/local/bin/magic on macOS
exec ssh rts-vm magic "$@"
```

```javascript
# Inside zone alpha's authorized_keys
command="/usr/local/bin/agent-control"
  ,no-port-forwarding,no-pty,no-X11-forwarding ssh-ed25519 AAA... rts-daemon
command="/usr/local/bin/agent-message"
  ,no-port-forwarding,no-pty,no-X11-forwarding ssh-ed25519 BBB... operator
```

```bash
ssh workstation tail -f /rts/zones/alpha/events
```

```javascript
Operator's host
├── magic CLI ──ssh──► RTS daemon (workstation)
├── Web browser ──ssh tunnel──► Web UI (workstation)
├── VS Code Remote-SSH ──ssh──► Files in zones (workstation)
└── SSHFS ──ssh──► Zone filesystem (workstation)

Workstation
├── RTS daemon
│   ├── Local zones (Unix socket)
│   └── Remote zones via ssh ──ssh──► Other host's daemon
├── Agent zones
│   └── (each with) sshd inside, command= restricted authorized_keys
└── Web UI

Other host
└── Agent zones, sshd, etc.
```

```javascript
magic alpha grep foo .
   ↓
magic resolves zone alpha → host=workstation, daemon-socket=/run/rts/sock
   ↓
ssh -S ~/.ssh/cm-workstation workstation magic-local alpha grep foo .
   ↓
remote magic-local talks to local Unix socket, runs bwrap, execs grep
```

1. Cross-zone: agent in zone alpha needs to interact with something in zone beta on the same host. (Mostly solved by filesystem operations on the host side; SSH is overkill.)
2. Cross-host: zones live on different machines. Operator on laptop, RTS daemon on workstation, agents on a remote server. (SSH is the natural answer.)
3. Cross-platform: macOS operator with Linux VM running the engine. (SSH is already the de facto answer for VM access.)
4. Cross-trust-boundary: untrusted agent zone, trusted operator zone, controlled communication channel. (SSH gives you authenticated, mediated channels.)
5. Cross-tool: a Mac-side editor needs to operate on files in a Linux-side zone. (SSH-based remote filesystems.)

- VS Code Remote-SSH is the killer app here. The operator opens VS Code, points it at the Linux VM (or a remote server), and edits files inside zones with full IDE features. The whole "click a file in the map, open it in my Mac editor" flow becomes "click a file, VS Code Remote-SSH opens it." Zero engineering on your side; VS Code does it.
- Cursor, JetBrains Gateway, Zed all have similar remote-SSH capabilities now.
- For non-IDE tools, SSHFS mounts the remote filesystem locally; Finder, vim, whatever, all work transparently.

- Identity: every action against an agent is authenticated by its initiator's SSH key. The event log records "operator <key fingerprint> sent message X" with cryptographic certainty.
- Authorization: the authorized_keys file is the policy. To grant the operator the ability to inject prompts, add their key with command="/agent-message". To revoke, remove the key. Live policy changes via file edits, exactly matching the Plan 9 / chroot model.
- Per-command capability: the same key can have multiple authorizations with different command= restrictions. Granular permissions without inventing an auth framework.
- Audit: SSH logs every connection and every command. Forensics is free.
- Off-host: the same model works whether the agent is local or remote. Cross-host agents are no more complex than local ones.

- Each operator has their own SSH key registered with the daemon.
- authorized_keys configures their permissions: read-only observer, command issuer, zone admin, etc.
- The web UI can be served per-operator over SSH tunnels; each gets their own session with their own permissions.
- Every action is audit-logged with the SSH key fingerprint as the principal.

1. Local-first, SSH-native. Architecture works with daemon and agents on the operator's local machine or remote. Same code path, different ssh config.
2. SSH for: cross-host transport, macOS-VM access, multi-operator authentication, agent control plane, remote file access.
3. Unix sockets for: same-host, same-trust-domain communication. The hot path is local; the reach path is SSH.
4. magic resolves transport from zone location. CLI invariant.
5. authorized_keys with command= is the agent control authorization mechanism. Live-editable, file-based, matches the rest of the architecture's "policy is a file" philosophy.
6. ControlMaster/ControlPersist is mandatory, not optional. It's the difference between "SSH is too slow" and "SSH is fine."
7. Document Tailscale/WireGuard as a complementary recommendation for cross-NAT reachability. Don't bake it in; just make sure your SSH-based design works on top of it.
8. VS Code Remote-SSH is the recommended editor integration. Document the workflow; let the operator use whatever editor they like; you're not building editor integrations.

- Operator's magic CLI to RTS daemon: SSH (when remote)
- Operator's browser to web UI: SSH tunnel (when remote)
- VS Code / editors to zone files: SSH (Remote-SSH or SSHFS)
- RTS daemon to agent zones: SSH (cross-host) or Unix socket (same-host)
- Agent-to-agent (when allowed): SSH with explicit authorization
- Cross-host RTS daemon coordination: SSH (mesh of daemons)

1. Single-host vs. multi-host as the v1 target: I'd argue start single-host, build with SSH-readiness (use SSH-shaped abstractions for transport so multi-host is a config change later). Don't ship multi-host in v1 but don't paint into a single-host corner.
2. SSH certs vs raw keys: raw keys for personal scale, certs when you have multiple operators/machines. Raw keys + a documented migration path is fine for v1.
3. Per-zone sshd vs muxed: per-zone for v1 (simple, isolated). Muxed if scale demands.
4. What gets a command= restriction in agent zones: at minimum, separate restrictions for "RTS daemon control" and "operator interactive shell." Maybe also "operator message injection" as its own restricted endpoint. Define the matrix early because it shapes the agent-control protocol.
5. Tailscale/WireGuard recommendation strength: just-document, or actually build setup helpers? I'd go with document for v1 — operators who care will know what they're doing.
6. VS Code Remote-SSH integration depth: document workflow, or auto-generate .ssh/config entries from zone definitions? Probably the latter eventually but document-only for v1.


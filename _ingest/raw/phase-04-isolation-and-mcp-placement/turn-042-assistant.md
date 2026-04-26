---
turn_id: 042
merged_turn_id: 030
role: assistant
phase: 04-isolation-and-mcp-placement
source_lines: [2804, 3073]
source_sha256: 16415535950bab24d20013814794dd1f28fd3a87806a4d6674a2b7e07f3373f3
char_count: 19843
---



## Assistant

Yes, and this is a genuinely useful thing to do — it's the right control-plane primitive for several of the problems we've been circling, particularly "how does the operator issue zone-scoped commands without leaving their shell." Let me work through what's possible, because the answer depends on what you mean by "control," and the options form a ladder similar to the chroot/bubblewrap one.

When you type `magic do-something foo bar` at a shell, `magic` is just an executable on `$PATH` that receives `do-something foo bar` as its argv. Whether `magic` can "control" what follows depends on whether "what follows" is:

Case 2 is where most of the value lives and where your intuition probably is. Case 3 is possible but requires different mechanisms. Let me walk all three because the design choice between them matters.

`magic create-zone alpha`, `magic list-zones`, `magic transfer foo.py alpha beta` — these are just subcommands. You write `magic` in Rust, it parses argv, does the thing. Standard CLI pattern, same as `git`, `docker`, `kubectl`. No OS magic required.

This is table stakes and you'd want it regardless.

Pattern: `magic <zone> <any command>` runs that command inside the zone. Examples:

This is structurally identical to how `sudo`, `nice`, `time`, `taskset`, `chroot`, `docker run`, `ssh`, and `nsenter` work. You write a command that sets up an environment and then execs the target. Everything you've built into the chroot/bubblewrap engine becomes available from the shell with one-word ergonomics.

Implementation in Rust:

Using `exec` (not `spawn`) means `magic` becomes `bwrap`, which becomes the command. Your shell sees it as a single process that replaces itself twice; exit codes, signals, stdin/stdout, terminal control — everything flows correctly. Ctrl-C works. Pipes work. Redirect works. It's transparent.

This is the most useful single thing `magic` can do. Every other shell-level feature is nice-to-have; this one turns the zone model from an RTS-internal concept into a first-class shell primitive.

Concrete properties:

This is the single most useful thing to build. The whole RTS becomes shell-scriptable.

What if you want `magic` to set state that persists in your shell after it returns? E.g., "once I've run `magic activate alpha`, every subsequent command in this shell runs inside zone alpha until I type `magic deactivate`"?

This is fundamentally harder because a child process cannot modify its parent's environment. When `magic` exits, any cwd change, env var set, namespace unshare, or alias defined inside `magic` vanishes. The shell is the parent; `magic` is the child. Unix process model is explicit: children can't reach up.

The mechanisms that exist to work around this, ranked by how much they demand from the user:

`magic` is defined as a shell function rather than a standalone binary, so it executes in the shell's own process and can modify shell state.

Combine with a `preexec` hook (bash `trap DEBUG`, zsh `preexec`, fish `fish_preexec`) that wraps every subsequent command in the zone if `$MAGIC_ZONE` is set:

Effectively this gives you: "I've activated zone alpha; now every command I type gets routed through `magic alpha ...` transparently."

Pros: real session-level control. Persists across commands. Standard shell primitives.
Cons: shell-specific (bash vs zsh vs fish each need their own); users have to source a setup file; debugging is fiddly; `preexec` has edge cases (pipelines, subshells).

Prior art: `conda activate`, `nvm use`, `direnv`, `pyenv` — all of these are shell functions that manipulate shell state because they can't be done from a child process alone. They all ship a "one-liner" the user adds to their shellrc. This is the standard pattern and users are accustomed to it.

`magic activate alpha` spawns a new shell as a child with `MAGIC_ZONE=alpha` set and a customized prompt, and you work in that subshell. `exit` drops back to your original shell with the variable unset.

This is what `nix-shell` does. Simpler than preexec hooks, but you pay a subshell per activation.

Pros: simpler than A, no preexec hook needed, works identically across shells if you spawn a known shell.
Cons: nested shells can confuse users, history can get complicated, each activation is a new process.

`magic alpha` launches a new shell inside zone alpha (via bubblewrap), and you just use that shell as your working environment. This is the thing I already described as "`magic alpha bash`" — it's Mechanism C, but framed as "this is your primary workflow."

The user opens a terminal, types `magic alpha` (or their terminal launches it automatically), and is now inside zone alpha for the lifetime of that terminal. Multiple zones = multiple terminals. tmux/screen with per-zone panes.

Pros: simplest mental model — a terminal is a zone. No session-tracking magic.
Cons: requires the operator to think about which terminal is which zone, forces multi-terminal or multi-pane workflow.

You modify the `$PATH` so that common commands (`bash`, `node`, `python`, `git`) resolve first to wrapper scripts that re-exec through `magic`. Extreme; fragile; usually the wrong idea. Mentioned for completeness because people sometimes reach for it — don't.

Build Case 2 first and call it done for 80% of what you want. magic <zone> <cmd> is the primary shell interface. Everything composable, no session state, no shell hooks.

Add Mechanism A (shell function with preexec hook) as an optional opt-in for users who want the `conda activate`-style experience. Ship a `magic.bash`, `magic.zsh`, `magic.fish` that users source. Keep the core tool standalone.

Don't build C (replace shell) as the primary interface because it forces a workflow. Do offer `magic <zone>` with no trailing command as a shortcut for "drop me into a shell in this zone" — users who want C can use that.

Don't build D. Users who want transparent interception should use A.

You asked specifically about controlling "subsequent commands wrt the OS." Given Case 2 as the vehicle, here's what controls you can realistically apply to any command run via `magic <zone> <cmd>`:

Filesystem namespace (via bubblewrap/chroot): the command sees only the zone's filesystem. This is the core thing.

Process namespace: the command is PID 1 inside the zone, sees no host processes.

Network namespace: the command has its own network stack. You can route it through a proxy, firewall it, give it no network at all, or share the host's network.

User/UID: the command runs as a non-root user on the host even if the wrapper was launched with privileges, or runs as "root" inside a user namespace while being unprivileged outside.

Cgroup limits: CPU, memory, I/O ceilings per invocation.

Environment variables: you can whitelist/blacklist, inject zone-specific secrets, strip potentially-leaky env (`SSH_AUTH_SOCK`, `AWS_*`).

Working directory: auto-chdir to the zone's workspace.

File descriptors: close everything except stdin/stdout/stderr, or specifically pass others (useful for the `/control/` files protocol).

Signal handling: wrap the command so you can interrupt cleanly (SIGTERM before SIGKILL, etc.).

Seccomp filters: deny specific syscalls. Overkill unless you have a specific threat.

Auditing: log every `magic` invocation to the event log. The RTS now sees operator activity as events on the map too — the operator becomes a pseudo-agent, which is the "operator as peer in the namespace" property from the Plan 9 turn.

All of this can be configured per-zone via the zone's policy file. `magic alpha grep foo .` reads alpha's policy, sets up the environment accordingly, execs.

A non-exhaustive list of subcommands that would be natural:

This is essentially a complete operator CLI. For any given user session, the web UI and the CLI should be interchangeable — whatever you can click in the map, you can type via `magic`. This matters because power users live in the shell and you want to reward that.

magic is an RTS client. It connects to the RTS daemon (over a Unix socket, typically `/run/rts/sock` or `$XDG_RUNTIME_DIR/rts/sock`) and issues RPCs. The RTS handles the actual zone setup, policy lookup, event logging. `magic` is thin — it translates shell ergonomics into RTS API calls.

Every invocation emits events. `magic alpha grep foo .` logs an event: "operator ran `grep foo .` in zone alpha at T." The RTS sees it. The map shows an edge from the "operator" pseudo-agent to whatever files grep touched (detectable via the zone's file-event stream or via `grep`'s exit and the file-access timestamps). The operator's work becomes data alongside the agents' work.

Shell completion. Zone names, agent IDs, common subcommands all completable. `magic alpha <tab>` completes files inside alpha's workspace. This is quality-of-life but significantly raises the tool's usability.

magic respects zone policy for itself too. If the operator is fenced out of a zone (rare, but you might want a "read-only observation" mode for paired operators), `magic` enforces it. This is where your "operator as pseudo-agent" model pays off — policy applies uniformly.

One thing worth being explicit about: in Case 2, `magic` controls each invocation of a command, not the subsequent commands as session state. The preexec hook in Mechanism A bridges this gap — once activated, every subsequent command you type in that shell runs through `magic` automatically.

The operator-facing experience with A + preexec:

The subtle case is shell builtins (`cd`, `export`, `alias`). They can't be wrapped because they execute in the shell itself, not as subprocesses. This is usually fine because (a) `cd` inside a zone still makes sense (changes your current zone-relative directory), and (b) `export` setting an env var affects your host shell, which is usually what you want. But it's an asymmetry worth knowing about.

If you want complete interception including builtins, you'd have to replace the shell — back to Mechanism C. A/preexec is 95%; C is 100% with more friction.

A few prior-art tools worth knowing about because they solve related problems:

Mental model: magic is to your RTS as kubectl is to Kubernetes. It's the shell-side control plane. The web UI and the CLI are sibling clients of the same daemon.

A few things to decide early because they shape the UX:

Transport to the RTS daemon: Unix socket is correct. HTTP is fine but socket is more Unix-native and gets you `SO_PEERCRED` for authentication (the RTS knows which Unix user invoked `magic`).

Authentication/authorization: for single-operator personal tools, `SO_PEERCRED` is enough — only the owning user can connect. For multi-operator, you'd need real auth; that's a later concern.

Command argument escaping: `magic alpha bash -c 'echo $HOME'` needs to preserve the quoting correctly. Shell quoting is notoriously easy to mess up. Use `exec` (not shell interpolation) and pass argv as an array, not a string. This is a class of bug to actively avoid.

Signal forwarding: Ctrl-C in the terminal should interrupt the inner command, not just `magic`. `exec`ing bubblewrap handles this correctly; don't insert Rust-level signal handlers between bubblewrap and the command.

Exit codes: the inner command's exit code should propagate. `exec` handles this automatically.

stdin/stdout/stderr/TTY: interactive commands need a TTY. bubblewrap passes the parent's TTY through by default. Non-interactive commands (piped input/output) should also work. Test both early — TTY bugs are insidious.

Completion: generate shell completion (bash, zsh, fish) at install time via something like `clap_complete`. Users expect tab-completion in 2026.

Updating the diagram from last turn mentally: `magic` is a new block in the "Operator interfaces" tier, sibling to 2D map view, 3D monitor, and agent TUIs. It talks to the RTS core via the same API the map talks to. It reads zone specs from the world state, emits events to the event log, and executes commands through the isolation layer.

The full set of operator interfaces becomes:

Five peers, all clients of the same daemon, all doing the same operations through different surfaces. That's architecturally clean and it matches how mature tools (Docker, Kubernetes, Nix) actually end up structured.

Week 1 of CLI work, on top of the engine that already exists:

That's a week of focused work and gives you full CLI coverage. The engine from previous turns powers all of it; `magic` is just a well-shaped client.

Decisions worth locking:

Want to dig into the preexec hook design specifically, the socket protocol between `magic` and the daemon, the completion-generation story, or the event schema for operator-as-pseudo-agent?

```javascript
magic alpha grep -r TODO src/
magic alpha vim src/foo.py
magic beta npm install
magic shared ls
magic alpha bash    # drop into an interactive shell inside the zone
```

```rust
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let zone = &args[1];
    let command = &args[2..];
    
    let zone_spec = load_zone(zone)?;
    let bwrap_args = build_bwrap_args(&zone_spec, command);
    
    // Replace this process with bwrap
    Command::new("bwrap").args(&bwrap_args).exec();
}
```

```bash
magic() {
    case "$1" in
        activate)
            export MAGIC_ZONE="$2"
            export PS1="(magic:$2) $PS1"
            ;;
        deactivate)
            unset MAGIC_ZONE
            ;;
        *)
            command magic "$@"  # fall through to real binary
            ;;
    esac
}
```

```bash
preexec() {
    [[ -n "$MAGIC_ZONE" && "$1" != magic* ]] && exec magic "$MAGIC_ZONE" "$@"
}
```

```bash
magic() {
    if [[ "$1" == activate ]]; then
        MAGIC_ZONE="$2" bash --rcfile <(echo "PS1='(magic:$2) $PS1'; source ~/.bashrc")
    fi
}
```

```javascript
$ magic activate alpha
(magic:alpha) $ grep -r TODO .     # runs inside zone alpha
(magic:alpha) $ vim src/foo.py      # edits inside zone alpha
(magic:alpha) $ npm test            # runs inside zone alpha
(magic:alpha) $ cd ..               # this is a shell builtin, doesn't go through magic
(magic:alpha) $ ls                  # this still runs in zone alpha
(magic:alpha) $ magic deactivate
$ ls                                # back to host
```

1. Arguments to magic itself (trivial — magic reads them and does whatever)
2. A subsequent command that magic executes (magic alpha grep foo . → magic runs grep foo . in a controlled environment)
3. Commands you'll type after magic in the same shell session (this is the hard and interesting case)

- Pipes cross zones cleanly: magic alpha cat foo.py | magic beta sh -c 'cat > imported.py' transfers content by piping through the zone boundary. The zones don't share a filesystem, but they share stdin/stdout because that's how Unix pipes work. This is a nice property — cross-zone communication through the shell falls out for free.
- Environment passes through: your shell's env vars reach the inner command (you can filter if you want).
- Interactive shells work: magic alpha bash drops you into a bash inside the zone. From the operator's perspective, it's like SSH'ing into a container, but without SSH. Exit to return to the host shell.
- Scripts compose: magic alpha make test && magic alpha git commit is natural.

- magic zone create <name> / zone destroy <name> / zone list
- magic transfer <path> <from-zone> <to-zone>
- magic share <path> <zone-a> <zone-b> (hard-link)
- magic snapshot <zone> / magic rollback <zone> <snap>
- magic agent spawn <kind> <zone> (launches Claude Code / OpenCode in a zone)
- magic agent kill <id> / magic agent pause <id> / magic agent resume <id>
- magic agent tail <id> (follow event stream)
- magic agent send <id> <message> (inject prompt)
- magic policy edit <zone> (opens the policy file in $EDITOR)
- magic replay <zone> --from <time> (time-scrubbing from CLI)
- magic diff <zone> (git-style diff of what's changed in a zone)
- magic watch (tail the event log, human-readable)
- magic map (open the web UI in a browser)
- magic <zone> <cmd> (the prefix-launcher from Case 2)
- magic <zone> (no command → drop into shell in that zone)

- nsenter: enters existing Linux namespaces. Not a launcher; operates on running processes. Useful primitive but not the user-facing shape you want.
- firejail: "bubblewrap but older and with a security focus." Could be an alternative to bubblewrap; I still prefer bwrap.
- systemd-run: spawn a command in a transient systemd unit with cgroup limits, name it, supervise it. Complementary to magic; magic could use systemd-run under the hood for resource management.
- toolbx / distrobox: Fedora/Ubuntu tools for running commands in containers with tight host integration. Similar philosophical shape ("run this command in an isolated env") — worth reading their code for UX decisions.
- direnv: perfect example of Mechanism A done well. Activates env per-directory via shell hook. Users trust and love it.
- nix-shell / nix develop: Mechanism B done well. Spawns a subshell with specific deps available. Users are very comfortable with this pattern.
- kubectl exec: prefix-launcher for Kubernetes pods. Ergonomically the closest match to what magic <zone> <cmd> is doing.

- Map view: visual, strategic, zone-oriented
- 3D monitor: ambient, embodied, long-session
- OS handoff: click-through to existing editors
- Agent TUIs: direct agent interaction
- magic CLI: shell-native, scriptable, keyboard-first

1. Shell-builtin opacity: as noted, cd, export, etc. can't be intercepted without shell-level integration. This is a known limitation of any command-wrapper tool; users generally understand it.
2. Non-shell invocations bypass magic: if a script spawns a command directly via exec rather than calling magic, it runs on the host, not in a zone. For scripts to respect zones, they need to use magic explicitly. You can partially mitigate with LD_PRELOAD tricks but don't — that path leads to pain.
3. Performance overhead per invocation: bubblewrap setup is ~5-30ms. For most commands this is negligible; for very fast commands in tight loops (find ... -exec), it adds up. An operator running a big find loop might notice. Rarely a practical issue but worth knowing.
4. The preexec hook is opinionated: some users have their own preexec logic (time tracking, command logging, custom prompts). magic's hook needs to play nicely. The pattern is to have magic activate install the hook and magic deactivate remove it, rather than always-on.
5. Windows/WSL story: magic runs in WSL natively. From PowerShell/cmd on the Windows side, it's "run wsl magic <...>". Not as clean as native Linux but acceptable. Windows-native operators can use the web UI primarily.

1. Core binary magic with Case 2 as primary: magic <zone> <command> execs via bubblewrap. magic <zone> with no command drops into $SHELL.
2. Socket client talks to RTS daemon. Zone resolution and policy lookup happen server-side.
3. Subcommands for the common operations: zone create/list/destroy, agent spawn/kill/tail, policy edit, transfer, share, snapshot.
4. Completion scripts for bash/zsh/fish.
5. Optional shell integration (Mechanism A) as a sourceable file, documented as opt-in.

1. magic or another name? "magic" is cute but generic — is there something more specific that fits the project's identity? rts, zone, something invented?
2. Prefix-launcher vs. activate-based as the primary interface — I'd argue prefix-launcher, with activate as an optional convenience.
3. Socket location: $XDG_RUNTIME_DIR/rts/sock is the standard choice.
4. Shell integration scope: bash+zsh only, or fish included? (Fish has a fairly different preexec model.)
5. How much of the operator's shell activity gets logged to the event log? Every magic invocation, or just ones that modify state? Privacy vs. observability trade.


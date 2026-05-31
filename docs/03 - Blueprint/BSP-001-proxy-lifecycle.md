# BSP-001: Anthropic Proxy Lifecycle Contract

**Status**: Issue 1, 2026-04-27
**Supersedes**: ad-hoc proxy start dance in `__main__.py:_run_agent_supervisor_smoke`
**Related**: RFC-002 §"Process lifecycle", RFC-008 §"Failure modes"

## 1. Scope

This BSP specifies the proxy server's lifecycle within an LLMKernel session. It answers four questions left ambiguous before this issue:

1. **Who owns the proxy lifecycle?** — the kernel (V1 default), with operator override.
2. **Is the proxy mandatory?** — yes. Every spawned agent's Anthropic traffic flows through a local proxy. No "direct to api.anthropic.com" mode.
3. **Which proxy starts by default?** — the `AnthropicPassthroughServer` (transparent mitm + traffic capture). Compatible with both auth modes.
4. **What happens when the contract is violated?** — kernel exits with a numbered K-class failure before any agent spawn is attempted.

## 2. Decomposed configuration dimensions

Prior code conflated four orthogonal dimensions into a single `use_bare` flag. They are now separate:

| Dimension | Value | Source |
|---|---|---|
| `auth.mode` | `api_key` \| `oauth` | `LLMKERNEL_USE_BARE=1` selects `api_key`; default `oauth` |
| `proxy.mode` | `passthrough` \| `litellm` | `LLMKERNEL_PROXY_MODE` env; default `passthrough` |
| `proxy.lifecycle` | `kernel_owned` \| `external` | `LLMKERNEL_LITELLM_ENDPOINT_URL` env presence: set ⇒ `external`; unset ⇒ `kernel_owned` |
| `proxy.url_source` | `auto_assigned` \| `env_override` | implied by `proxy.lifecycle` |

Legal combinations (all four cells of the auth × proxy product space):

| auth | proxy | Status | Notes |
|---|---|---|---|
| `api_key` | `passthrough` | OK | Default for V1 Tier 4 / Tier 5; transparent capture |
| `api_key` | `litellm` | OK | LiteLLM model routing; supervisor sets `ANTHROPIC_BASE_URL` |
| `oauth` | `passthrough` | OK | OAuth keychain + capture; what Tier 3 smoke uses |
| `oauth` | `litellm` | **REJECTED at boot** | LiteLLM proxy breaks OAuth's model-resolution preflight per [agent_supervisor.py:259-262](../../vendor/LLMKernel/llm_kernel/agent_supervisor.py#L259-L262). The kernel exits with K11 if this combination is configured. |

## 3. Lifecycle sequence

The `pty-mode` boot sequence (RFC-008) gains step 2.5:

1. Boot enters `pty_mode.main`. Marker `pty_mode_main_entry`.
2. Read env, connect socket. Markers `pty_mode_env_read`, `pty_mode_socket_connected`.
3. Emit ready handshake. Marker `pty_mode_ready_emitted`.
4. **(NEW)** Resolve and start the proxy:
   - If `LLMKERNEL_LITELLM_ENDPOINT_URL` is set ⇒ `proxy.lifecycle = external`. Skip startup; trust the operator. Marker `pty_mode_proxy_external` with the URL.
   - Else ⇒ `proxy.lifecycle = kernel_owned`. Read `LLMKERNEL_PROXY_MODE` (default `passthrough`). Validate the auth × proxy combination per §2; reject illegal combinations with K11 (see §5). Construct the chosen server with `port=0` (OS-pick). Call `start()`. Set `os.environ["LLMKERNEL_LITELLM_ENDPOINT_URL"]` to the bound URL so downstream `attach_agent_supervisor` reads it uniformly. Marker `pty_mode_proxy_started` with mode and URL.
5. Attach kernel subsystems. The supervisor's `litellm_endpoint_url` resolves through the env var set in step 4. Marker `pty_mode_dispatcher_started`.
6. Read loop runs until shutdown.
7. **(NEW)** On exit (finally): if the proxy was `kernel_owned`, call `stop()`. Marker `pty_mode_proxy_stopped`.

## 4. Caller obligations

After this BSP, the supervisor's `validate_pre_spawn` continues to HEAD-check the URL it was given. It does NOT decide whether a proxy should exist; that decision is made at boot per §3. If the URL is unreachable at spawn time, `PreSpawnValidationError` raises with `log_signature="provisioning.litellm.unreachable"` and the synthetic `agent_spawn:error` span flows to the cell as before.

The supervisor is therefore stateless about lifecycle: it gets a URL, it validates the URL. Lifecycle ownership lives entirely in `pty_mode.main`.

## 5. Failure modes

| Code | Symptom | Stage marker | Operator action |
|---|---|---|---|
| K11 | Illegal `(auth, proxy)` combination at boot | `pty_mode_proxy_config_rejected` with `auth_mode`, `proxy_mode` | Set `LLMKERNEL_PROXY_MODE=passthrough` or unset `LLMKERNEL_USE_BARE` |
| K12 | Proxy startup raised (port unavailable, mitmdump missing, etc.) | `pty_mode_proxy_start_failed` with `error_type`, `error` | Inspect `kernel.stderr.<id>.log`; verify `pixi run -e kernel mitmdump --version` works for passthrough mode |
| K13 | Proxy started but `health_check` HEAD on `<base_url>/v1/models` fails within 5s | `pty_mode_proxy_unhealthy` with `url`, `error` | Likely transient (passthrough still spinning up); investigate if persistent |

K11–K13 cause the kernel to exit cleanly with a non-zero code BEFORE the read loop, so the extension's `kernel.shutdown_request` round-trip does not run; the extension sees PTY EOF and surfaces the kernel.stderr capture.

## 6. Test paths

| Tier | Configuration | Result |
|---|---|---|
| Tier 3 OAuth+mitm smoke | Harness manually starts passthrough; sets `LLMKERNEL_LITELLM_ENDPOINT_URL` to its URL | Unchanged. The harness pre-empts kernel-owned startup via `external` lifecycle. |
| Tier 4 e2e (`live-kernel.test.ts`) | No env override. Test sets `LLMKERNEL_USE_BARE=1`; kernel-owned passthrough starts at boot. | **Just works** after this BSP. The artificial proxy bootstrap previously needed in the test goes away. |
| Tier 5 F5 (manual) | No env override. Operator's `.env` provides `ANTHROPIC_API_KEY`; kernel-owned passthrough starts at boot. | **Just works** after this BSP. |

## 7. Migration

`LLMKERNEL_USE_BARE` retains its current meaning (selects API-key auth, sets `ANTHROPIC_BASE_URL`). It is no longer a proxy-mode signal. Operators who want the LiteLLM proxy explicitly set `LLMKERNEL_PROXY_MODE=litellm`. The default migration path (do nothing) lands every operator on `passthrough`, which is the broader-compatibility choice.

## 8. Why passthrough as default

The LiteLLM proxy was the V0 default because it was implemented first. The `AnthropicPassthroughServer` came later, replaced the homegrown FastAPI forwarder with mitmdump (handles streaming, gzip, OAuth model-resolution), and works under both auth modes. It is strictly more general; the only reason to choose LiteLLM is non-Anthropic model routing, which V1 does not exercise.

## Changelog

- **Issue 1, 2026-04-27**: initial.

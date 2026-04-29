# Anti-pattern: secrets logged or persisted instead of env-only

**Status**: anti-pattern (discipline; enforce always)
**Source specs**: [RFC-009 §4.4](../../rfcs/RFC-009-zone-control-and-config.md), [Engineering Guide §11.5](../../../Engineering_Guide.md#115-editing-intermediate-files-instead-of-the-canonical-doc)
**Related atoms**: [anti-patterns/path-propagation](path-propagation.md), [anti-patterns/workspace-shadows-global](workspace-shadows-global.md), [decisions/capabilities-deferred-v2](../decisions/capabilities-deferred-v2.md)

## The trap

Authentication credentials (`ANTHROPIC_API_KEY`, `*_token`, `*_password`, `*_secret`) appear in any of:

- A debug `logger.info(f"config = {config}")` that includes the full settings dict
- VS Code `settings.json` (workspace OR user), where they round-trip into operator screenshots and git commits
- `metadata.rts.config` in the `.llmnb` file, which gets shared/committed
- Marker file diagnostic output, where they surface in test artifacts and CI logs

Each leak is permanent: secrets in git history can't be un-leaked; secrets in a CI artifact stay in the artifact retention window; secrets in a logger that ships to OTLP go to whatever back-end consumes it.

## Why the trap is silent

- The leak happens at write time, not at read time. By the time you see the leaked value in a log file or screenshot, the damage is done.
- Logging libraries don't know which fields are secret. A generic `logger.debug(f"resolved config: {cfg}")` can't tell `claude_path` from `anthropic_api_key`.
- Settings UI and `metadata.rts.config` accept arbitrary keys. There is no schema-level prohibition unless we add one.
- The "convenience" of pasting an API key into a settings file is exactly the temptation that becomes a leak.

## The discipline

Per [RFC-009 §4.4](../../rfcs/RFC-009-zone-control-and-config.md):

> **Authentication credentials (e.g., `ANTHROPIC_API_KEY`)** | env var ONLY (security: never persisted in VS Code settings or `metadata.rts.config`)
>
> This is a hard rule. Credentials in workspace settings or in `metadata.rts.config` are a forbidden-field violation per RFC-005 §"Forbidden secrets" and the metadata-loader's secret scan (extension side) MUST refuse to load any `.llmnb` carrying them.

The full discipline:

1. **Secrets are env-only.** `os.environ["ANTHROPIC_API_KEY"]` is the ONLY legal source. CLI args, settings files, `metadata.rts.config`, and source code are all prohibited.
2. **Logging redacts at the source.** `zone_control._record()` (per RFC-009 §6) emits credential values as the literal strings `<set>` or `<unset>` in marker files. Never the actual value.
3. **Loaders reject leaked secrets.** The extension's metadata-loader scans `.llmnb` files for `*_key`, `*_token`, `*_password`, `_secret` field names and refuses to ship a hydrate envelope if any are found.
4. **K82 surfaces the violation.** Per [RFC-009 §8](../../rfcs/RFC-009-zone-control-and-config.md): `zone_control_forbidden_secret` with `setting_name`, `source` is a kernel-fatal at agent-spawn time. The supervisor refuses to spawn if a secret was sourced from a non-env place.

## The diagnostic rule

> **Treat every credential as already-leaked if it has ever lived outside `process.environ`.** Once a secret has been `update()`'d into VS Code settings or persisted into a file, treat it as compromised: rotate, then re-source from env only.

Generalization to any sensitive value: **the env-var contract is a one-way street**. Values flow in via the operator's environment; they MUST NOT flow out into any persistent surface (settings, files, logs, telemetry, marker files, OTLP attributes).

## Where this is enforced

| Surface | Enforcement |
|---|---|
| `zone_control._record()` | Redacts credential values to `<set>` / `<unset>` in marker file emissions |
| `zone_control.resolve_zone_config(...)` | Raises K82 if a credential is sourced from anything but env |
| Extension metadata-loader | Scans `.llmnb` for forbidden field names; refuses to hydrate if found (per RFC-005 §"Forbidden secrets") |
| Code review | Greppable check: `grep -rEn "_key|_token|_password|_secret" docs/rfcs/RFC-005-llmnb-file-format.md` should return zero hits ([Engineering Guide §9.3](../../../Engineering_Guide.md#93-grep-checks)) |
| OTLP attribute keys | The `llmnb.*` namespace MUST NOT include credential-typed values; see RFC-006 |

## Cost of avoiding it

The cost of avoiding leaks is essentially zero: `os.environ.get("ANTHROPIC_API_KEY")` is exactly as easy as any other source. The cost of hitting a leak — credential rotation, audit, possibly notifying users — is hours to days. Asymmetric.

## See also

- [RFC-009 §4.4](../../rfcs/RFC-009-zone-control-and-config.md) — the env-only rule for credentials.
- [RFC-009 §8](../../rfcs/RFC-009-zone-control-and-config.md) — K82 forbidden-secret failure mode.
- [decisions/capabilities-deferred-v2](../decisions/capabilities-deferred-v2.md) — V2 will formalize `access_secrets` as a capability check on top of this env-only base.
- [anti-patterns/path-propagation](path-propagation.md) — sibling: same `zone_control` module is the canonical entry point for both.
- [anti-patterns/workspace-shadows-global](workspace-shadows-global.md) — sibling: settings.json is the wrong source for both secrets and (per `useStub`) state-driving config.
- [Engineering Guide §11.5](../../../Engineering_Guide.md#115-editing-intermediate-files-instead-of-the-canonical-doc) — broader discipline against side-effects in derived artifacts.

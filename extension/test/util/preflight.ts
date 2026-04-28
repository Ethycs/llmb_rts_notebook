// FSP-003 Pillar B — environmental preflight.
//
// `preflightStub()` and `preflightLive()` run as `suiteSetup` fixtures and
// skip the entire tier with a clear human-readable reason on any check
// failure. This converts "200-second timeout because another VS Code
// instance held the install mutex" into a one-line skip with remediation
// pointer.
//
// Each preflight emits a `tier_skipped` JSON record to the marker file on
// failure so CI dashboards can distinguish "skipped due to environment"
// from "passing" or "failing." K74 is the failure-code namespace per
// FSP-003 §4 (preflight failures); the helpers don't throw — they call
// `this.skip()` on the supplied mocha context so the suite is marked
// skipped, not failed.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureMarkerFile } from './marker-tail.js';

interface MochaContext {
  skip(): void;
}

interface CheckResult {
  ok: boolean;
  /** Human-readable reason. Surfaced as the skip message. */
  reason?: string;
  /** Remediation pointer (e.g. "run pixi install -e kernel"). */
  remediation?: string;
}

/** Append a `tier_skipped` JSON record so CI dashboards see structured
 *  skip causes (FSP-003 §4 K74). Errors are swallowed — the marker
 *  writer must not affect test outcome. */
function recordTierSkip(tier: string, check: string, reason: string, remediation?: string): void {
  const target = process.env.LLMNB_MARKER_FILE ?? process.env.LLMNB_E2E_MARKER_FILE;
  if (!target) {
    return;
  }
  const record = {
    ts: Date.now(),
    component: 'preflight',
    event: 'tier_skipped',
    code: 'K74',
    tier,
    check,
    reason,
    remediation: remediation ?? null
  };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(record) + '\n', { encoding: 'utf-8' });
  } catch {
    /* swallow */
  }
}

/** Stub-tier check: vscode-test cache directory exists and contains at
 *  least one extracted VS Code archive. Looks for the `.vscode-test`
 *  directory under the extension root and inspects its children for
 *  `vscode-*` entries.
 *
 *  Implementation note: when @vscode/test-cli runs the suite, it has
 *  already populated the cache (otherwise it couldn't have launched VS
 *  Code), so the check is effectively belt-and-braces — but it surfaces
 *  the right remediation when the cache disappears between runs. */
function checkVscodeTestCache(): CheckResult {
  // The cache lives under <extensionRoot>/.vscode-test. We don't have the
  // extension root from inside the test process; walk up from cwd.
  const candidates = [
    path.resolve(process.cwd(), '.vscode-test'),
    path.resolve(process.cwd(), '..', '.vscode-test'),
    path.resolve(process.cwd(), '..', '..', '.vscode-test')
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const hasVscode = entries.some(
      (e) => e.isDirectory() && e.name.startsWith('vscode-')
    );
    if (hasVscode) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    reason: 'vscode-test cache empty',
    remediation: 'run `npm run download-vscode` (or any prior `test:stub` run)'
  };
}

/** Stub-tier check: no other VS Code instance holds the install mutex.
 *  We can't observe the mutex directly from inside the running test
 *  process (we ARE the second instance if there is one — our
 *  process is the one that loaded the extension). The downgrade
 *  symptom is "extension never activated." Since we already run inside
 *  the extension host, the only sensible heuristic is: did the
 *  extension actually load? But that's a postcondition, not a
 *  precondition. We surface this check as a no-op for now — it's
 *  primarily intended for the `pretest` phase of the runner shell, not
 *  the in-test fixture. The tier-separated user-data-dirs (FSP-003
 *  Pillar C) prevent the cross-talk that this check would otherwise
 *  catch. */
function checkVscodeMutex(): CheckResult {
  return { ok: true };
}

/** Live-tier check: pixi env imports llm_kernel cleanly. */
function checkPixiKernelEnv(): CheckResult {
  const r = spawnSync('pixi', ['run', '-e', 'kernel', 'python', '-c', 'import llm_kernel'], {
    encoding: 'utf-8',
    timeout: 15_000
  });
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      reason: 'kernel pixi env not installed (`import llm_kernel` failed)',
      remediation: 'run `pixi install -e kernel`'
    };
  }
  return { ok: true };
}

/** Locate the claude binary either on PATH or under the repo's pixi
 *  kernel env. The Extension Host's child_process inherits env from
 *  VS Code, which on Windows does not inherit pixi shell-activation.
 *  Looking up the pixi env explicitly as a fallback makes preflight
 *  (and the live test infrastructure that follows) work without
 *  requiring `pixi shell -e kernel` to have been run first.
 *
 *  Returns the absolute path to a known-good claude executable, or
 *  empty string if none is found. As a side effect, prepends the
 *  pixi env's bin dir to process.env.PATH so subsequent spawnSync
 *  calls in this preflight (and any subprocess.Popen inside the
 *  test's kernel) resolve `claude` naturally without each call site
 *  needing to know the absolute path. */
function locateClaudeAndUpdatePath(): string {
  // Try PATH first — if claude is already resolvable, no env munging.
  const fromPath = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    ['claude'],
    { encoding: 'utf-8', timeout: 3_000 }
  );
  if (!fromPath.error && fromPath.status === 0) {
    const lines = (fromPath.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0) {
      // On Windows, `where claude` may return multiple files when both
      // `claude` (POSIX shell script that ships in the pixi env) and
      // `claude.cmd` (Windows launcher) live in the same directory.
      // The first line is alphabetical (`claude` < `claude.cmd`), and
      // Windows can't execute the extensionless POSIX script. Prefer
      // a line ending in a Windows-executable extension (PATHEXT).
      // POSIX where/which always returns extensionless paths so this
      // filter is a no-op there.
      if (process.platform === 'win32') {
        const winExts = ['.cmd', '.exe', '.bat'];
        const winnable = lines.find((l) =>
          winExts.some((ext) => l.toLowerCase().endsWith(ext))
        );
        if (winnable) {
          return winnable;
        }
        // No PATH entry has a Windows extension; fall through to the
        // pixi-env probe below which explicitly looks for claude.cmd.
      } else {
        return lines[0];
      }
    }
  }
  // Fallback: walk up from cwd looking for .pixi/envs/kernel.
  const candidates: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    candidates.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const root of candidates) {
    const envRoot = path.join(root, '.pixi', 'envs', 'kernel');
    if (!fs.existsSync(envRoot)) continue;
    // Pixi env binary directories per platform:
    //   Windows: <env>/ holds the launchers shipped by pixi itself
    //            (claude.cmd from npm-style packages); <env>/Scripts/
    //            holds pip-installed entry-point exes (mitmdump.exe,
    //            mitmproxy.exe, etc.) — the Python venv layout.
    //   POSIX:   <env>/bin holds everything (single dir).
    // Both must be on PATH for the kernel's downstream subprocess.Popen
    // calls (claude AND mitmdump) to resolve. Activating "pixi shell -e
    // kernel" prepends both dirs; we mirror that explicitly here.
    const winBins = [envRoot, path.join(envRoot, 'Scripts')];
    const posixBins = [path.join(envRoot, 'bin')];
    const binDirs = process.platform === 'win32' ? winBins : posixBins;
    const exeName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    let claudePath = '';
    for (const bin of binDirs) {
      const candidate = path.join(bin, exeName);
      if (fs.existsSync(candidate)) {
        claudePath = candidate;
        break;
      }
    }
    if (claudePath) {
      // Prepend EVERY env bin dir so all pixi-installed binaries — not
      // just claude — resolve cleanly. mitmdump (BSP-001 passthrough
      // proxy) lives in Scripts/ on Windows and must be findable when
      // the kernel later calls shutil.which("mitmdump").
      const sep = process.platform === 'win32' ? ';' : ':';
      const currentPathParts = (process.env.PATH || '').split(sep);
      const additions = binDirs.filter(
        (d) => fs.existsSync(d) && !currentPathParts.includes(d)
      );
      if (additions.length > 0) {
        process.env.PATH = `${additions.join(sep)}${sep}${process.env.PATH || ''}`;
      }
      return claudePath;
    }
  }
  return '';
}

/** Live-tier check: claude CLI is locatable (PATH or pixi env fallback)
 *  and `--version` succeeds. */
function checkClaudeCli(): CheckResult {
  const claudeBin = locateClaudeAndUpdatePath();
  if (!claudeBin) {
    return {
      ok: false,
      reason: 'claude CLI not on PATH and not found under .pixi/envs/kernel/',
      remediation: 'install Claude Code per docs/setup.md, or run `pixi install -e kernel`'
    };
  }
  // shell: true is required on Windows when invoking a .cmd / .bat
  // launcher — Node's child_process.spawn cannot execute batch files
  // directly, only PE binaries. POSIX shell scripts work without it.
  const isCmd = process.platform === 'win32'
    && /\.(cmd|bat)$/i.test(claudeBin);
  const r = spawnSync(claudeBin, ['--version'], {
    encoding: 'utf-8',
    timeout: 5_000,
    shell: isCmd
  });
  if (r.error || r.status !== 0) {
    const detail = r.error
      ? `${(r.error as NodeJS.ErrnoException).code ?? 'error'}: ${r.error.message}`
      : `exit=${r.status} stderr=${(r.stderr ?? '').trim().slice(0, 200)}`;
    return {
      ok: false,
      reason: `claude --version failed at ${claudeBin} (${detail})`,
      remediation: 'reinstall Claude Code per docs/setup.md'
    };
  }
  return { ok: true };
}

/** Walk up from cwd looking for a .env file at any ancestor directory.
 *  Returns the absolute path to the first match, or empty string if none.
 *  Mirrors python-dotenv's find_dotenv(usecwd=True) which the kernel
 *  uses (RFC-009 §4.4 — credentials are env-only; a .env at the repo
 *  root is just shell env at process start, which preflight should
 *  honor identically to a manually-exported var). */
function findDotenv(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/** Read a .env file and return the parsed key/value map. Minimal
 *  parser — handles `KEY=value` lines, quoted values, blank/comment
 *  lines. We don't pull in the dotenv npm package because tests should
 *  not add runtime deps and the format is trivial. */
function parseDotenv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, { encoding: 'utf-8' });
  } catch {
    return out;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip matched surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Live-tier check: ANTHROPIC_API_KEY env, .env file, or claude OAuth.
 *  RFC-009 §4.4 — credentials are env-only. We honor a .env at the
 *  repo root as "env at process start" (matching the kernel's dotenv
 *  loader). On match the variable is also exported to process.env so
 *  the kernel inherits it on spawn. */
function checkAnthropicCredentials(): CheckResult {
  // 1) env var already set
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) {
    return { ok: true };
  }
  // 2) .env at repo root (matches kernel's find_dotenv usage)
  const envPath = findDotenv();
  if (envPath) {
    const parsed = parseDotenv(envPath);
    const fromFile = parsed.ANTHROPIC_API_KEY;
    if (fromFile && fromFile.length > 0) {
      // Export so the kernel subprocess inherits it.
      process.env.ANTHROPIC_API_KEY = fromFile;
      return { ok: true };
    }
  }
  // 3) Fallback: claude OAuth session probe
  for (const argv of [['/status'], ['auth', 'status']]) {
    const r = spawnSync('claude', argv, { encoding: 'utf-8', timeout: 8_000 });
    if (!r.error && r.status === 0) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    reason: 'no Anthropic credentials (no ANTHROPIC_API_KEY env, no .env at repo root, no valid claude OAuth session)',
    remediation: 'set ANTHROPIC_API_KEY env var, add it to .env at repo root, or run `claude login`'
  };
}

/** Live-tier check: no orphan `python -m llm_kernel pty-mode` processes.
 *  FSP-003 explicitly forbids killing them — we only surface and skip. */
function checkNoOrphanKernel(): CheckResult {
  const isWin = os.platform() === 'win32';
  let stdout = '';
  if (isWin) {
    // wmic is deprecated on Win11 but still ships; tasklist with /v also
    // exposes the cmdline via process trees. Use PowerShell as the
    // portable surface.
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Select-Object -ExpandProperty CommandLine"
      ],
      { encoding: 'utf-8', timeout: 5_000 }
    );
    stdout = r.stdout ?? '';
  } else {
    const r = spawnSync('pgrep', ['-fa', 'llm_kernel pty-mode'], {
      encoding: 'utf-8',
      timeout: 5_000
    });
    stdout = r.stdout ?? '';
  }
  const lines = stdout.split('\n').filter((l) => l.includes('llm_kernel') && l.includes('pty-mode'));
  // Filter out our own pid if it shows up (unlikely — we don't spawn
  // a kernel from the preflight context).
  const orphans = lines.filter((l) => !l.includes(String(process.pid)));
  if (orphans.length > 0) {
    return {
      ok: false,
      reason: `orphan kernel(s) from prior run (${orphans.length} match)`,
      remediation: 'kill the orphan `python -m llm_kernel pty-mode` process(es) and retry'
    };
  }
  return { ok: true };
}

/** Run an ordered list of checks; on the first failure, emit the
 *  tier_skipped record and call `ctx.skip()`. Returns true iff all
 *  checks passed. */
function runChecks(
  ctx: MochaContext,
  tier: 'stub' | 'live',
  checks: ReadonlyArray<{ name: string; run: () => CheckResult }>
): boolean {
  // Ensure marker file exists for the tier_skipped record.
  ensureMarkerFile(`preflight-${tier}`);
  for (const { name, run } of checks) {
    let result: CheckResult;
    try {
      result = run();
    } catch (err) {
      result = { ok: false, reason: `check ${name} threw: ${String(err)}` };
    }
    if (!result.ok) {
      const remediation = result.remediation ? ` — ${result.remediation}` : '';
      // eslint-disable-next-line no-console
      console.error(
        `[preflight:${tier}] K74 ${name} failed: ${result.reason ?? 'unknown'}${remediation}`
      );
      recordTierSkip(tier, name, result.reason ?? 'unknown', result.remediation);
      ctx.skip();
      return false;
    }
  }
  return true;
}

/** FSP-003 Pillar B — stub-tier preflight. Skips the suite via
 *  `this.skip()` on any check failure. Use as:
 *
 *      suiteSetup(function () {
 *        preflightStub(this);
 *      });
 */
export function preflightStub(ctx: MochaContext): boolean {
  return runChecks(ctx, 'stub', [
    { name: 'vscode_test_cache_populated', run: checkVscodeTestCache },
    { name: 'vscode_install_mutex_available', run: checkVscodeMutex }
  ]);
}

/** FSP-003 Pillar B — live-tier preflight. Stub checks plus live-only
 *  resource checks (pixi kernel env, claude CLI, credentials, no orphan
 *  kernels). Skips the suite on any failure. */
export function preflightLive(ctx: MochaContext): boolean {
  return runChecks(ctx, 'live', [
    { name: 'vscode_test_cache_populated', run: checkVscodeTestCache },
    { name: 'vscode_install_mutex_available', run: checkVscodeMutex },
    { name: 'pixi_kernel_env_importable', run: checkPixiKernelEnv },
    { name: 'claude_cli_on_path', run: checkClaudeCli },
    { name: 'anthropic_credentials_present', run: checkAnthropicCredentials },
    { name: 'no_orphan_kernel_processes', run: checkNoOrphanKernel }
  ]);
}

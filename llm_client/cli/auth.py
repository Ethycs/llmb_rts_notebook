"""
llm_client.cli.auth — `llmnb auth init` subcommand (PLAN-S5.0.3 §5.3).

Generates a random LLMNB_AUTH_TOKEN and writes it to .env. Errors if
.env is tracked by git (per PLAN §5.3 — secrets must stay untracked).
The token is consumed by S5.0.3d's TCP transport; this slice only
provisions it.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import secrets
import subprocess
import sys
from pathlib import Path


def add_arguments(parser: argparse.ArgumentParser) -> None:
    sub = parser.add_subparsers(dest="auth_action", required=True)

    init = sub.add_parser("init", help="Generate LLMNB_AUTH_TOKEN and write to .env.")
    init.add_argument(
        "--token-name",
        default="LLMNB_AUTH_TOKEN",
        help="Environment variable name (default LLMNB_AUTH_TOKEN).",
    )
    init.add_argument(
        "--env-file",
        type=Path,
        default=Path(".env"),
        help="Target .env file (default ./.env).",
    )
    init.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing entry without prompting.",
    )

    verify = sub.add_parser(
        "verify",
        help="Check that LLMNB_AUTH_TOKEN is present (does not echo the token).",
    )
    verify.add_argument(
        "--token-name",
        default="LLMNB_AUTH_TOKEN",
        help="Environment variable name (default LLMNB_AUTH_TOKEN).",
    )
    verify.add_argument(
        "--env-file",
        type=Path,
        default=Path(".env"),
        help="Target .env file (default ./.env).",
    )


def _is_gitignored(path: Path) -> bool:
    """Best-effort check that ``path`` is gitignored.

    Returns True when ``git check-ignore`` says the file is ignored, OR
    when there is no git repo at all (no .git in any parent — the
    untracked safety claim is moot if there's no VCS to leak to).
    """
    try:
        proc = subprocess.run(
            ["git", "check-ignore", "-q", str(path)],
            capture_output=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        # git not on PATH: treat as "no VCS to leak to".
        return True
    if proc.returncode == 0:
        return True
    if proc.returncode == 128:
        # Not a git repo — same conclusion as "no git".
        return True
    return False


def _is_tracked(path: Path) -> bool:
    """Check whether ``path`` is currently tracked by git."""
    try:
        proc = subprocess.run(
            ["git", "ls-files", "--error-unmatch", str(path)],
            capture_output=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        return False
    return proc.returncode == 0


def _do_init(args: argparse.Namespace) -> int:
    env_path: Path = args.env_file
    name: str = args.token_name

    if env_path.exists() and _is_tracked(env_path):
        print(
            f"error: {env_path} is tracked by git. Auth tokens must not "
            "be committed. Add it to .gitignore, run `git rm --cached "
            f"{env_path}`, then retry.",
            file=sys.stderr,
        )
        return 2
    if env_path.exists() and not _is_gitignored(env_path):
        print(
            f"warning: {env_path} is not gitignored. Add `{env_path.name}` "
            "to .gitignore to prevent accidental commits.",
            file=sys.stderr,
        )

    token = secrets.token_urlsafe(48)

    existing_lines: list[str] = []
    if env_path.exists():
        existing_lines = env_path.read_text(encoding="utf-8").splitlines()

    matched = False
    new_lines: list[str] = []
    for line in existing_lines:
        if line.startswith(f"{name}="):
            if not args.force:
                print(
                    f"error: {name} already set in {env_path}; pass --force to overwrite.",
                    file=sys.stderr,
                )
                return 2
            new_lines.append(f"{name}={token}")
            matched = True
        else:
            new_lines.append(line)
    if not matched:
        new_lines.append(f"{name}={token}")

    env_path.write_text("\n".join(new_lines).rstrip("\n") + "\n", encoding="utf-8")
    print(f"wrote {name} to {env_path} (token redacted)")
    return 0


def _read_token_from_env_file(env_path: Path, name: str) -> str | None:
    """Best-effort read of ``NAME=...`` from a dotenv-style file."""
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def _do_verify(args: argparse.Namespace) -> int:
    """Print whether the token is reachable, without echoing the value.

    Resolution order: process env first (so a CI override is honoured),
    then ``--env-file``. Outputs an 8-char hex prefix of sha256(token)
    so operators can tell whether two environments hold the same token
    without ever exposing the secret itself.
    """
    name: str = args.token_name
    env_path: Path = args.env_file

    token = os.environ.get(name)
    source = "environment"
    if not token:
        token = _read_token_from_env_file(env_path, name)
        source = str(env_path) if token else "(missing)"
    if not token:
        print(f"{name}: missing (looked in environment and {env_path})")
        return 2

    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    print(f"{name}: present (source={source}, sha256[:8]={digest[:8]})")
    return 0


def run(args: argparse.Namespace) -> int:
    if args.auth_action == "init":
        return _do_init(args)
    if args.auth_action == "verify":
        return _do_verify(args)
    print(f"error: unknown auth action {args.auth_action!r}", file=sys.stderr)
    return 2

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

from jupyter_client.kernelspec import KernelSpecManager, NoSuchKernel

from llm_kernel.notebook.notebook_format import (
    LLMNB_DISPLAY_NAME,
    LLMNB_KERNEL_NAME,
    LLMNB_LANGUAGE,
)
from llm_kernel.wire import versions as _versions


def build_kernelspec(
    *,
    python_executable: Optional[str] = None,
    display_name: str = LLMNB_DISPLAY_NAME,
) -> dict[str, Any]:
    exe = python_executable or sys.executable
    return {
        "argv": [
            exe,
            "-m",
            "llm_kernel.jupyter_kernel",
            "-f",
            "{connection_file}",
        ],
        "display_name": display_name,
        "language": LLMNB_LANGUAGE,
        "interrupt_mode": "message",
        "metadata": {
            "debugger": False,
            "llmnb": {
                "comm_target": _versions.COMM_TARGET,
                "wire_version": _versions.WIRE_VERSION,
                "schema_version": _versions.SCHEMA_VERSION,
            },
        },
    }


def add_arguments(parser: argparse.ArgumentParser) -> None:
    sub = parser.add_subparsers(dest="action", required=True)

    p_install = sub.add_parser("install", help="Install the LLMNB Jupyter kernelspec.")
    scope = p_install.add_mutually_exclusive_group()
    scope.add_argument(
        "--user",
        action="store_true",
        help="Install into the current user's Jupyter kernels directory.",
    )
    scope.add_argument(
        "--sys-prefix",
        action="store_true",
        help="Install into sys.prefix (default when neither --user nor --prefix is given).",
    )
    scope.add_argument(
        "--prefix",
        type=str,
        default=None,
        help="Install into a custom prefix directory.",
    )
    p_install.add_argument(
        "--name",
        type=str,
        default=LLMNB_KERNEL_NAME,
        help=f"Kernelspec name (default: {LLMNB_KERNEL_NAME}).",
    )
    p_install.add_argument(
        "--display-name",
        type=str,
        default=LLMNB_DISPLAY_NAME,
        help=f"Display name shown in Jupyter frontends (default: {LLMNB_DISPLAY_NAME}).",
    )

    p_uninstall = sub.add_parser("uninstall", help="Remove an installed LLMNB kernelspec.")
    p_uninstall.add_argument(
        "--name",
        type=str,
        default=LLMNB_KERNEL_NAME,
        help=f"Kernelspec name to remove (default: {LLMNB_KERNEL_NAME}).",
    )

    sub.add_parser("list", help="List installed Jupyter kernelspecs.")

    p_show = sub.add_parser("show", help="Print the LLMNB kernel.json descriptor.")
    p_show.add_argument(
        "--display-name",
        type=str,
        default=LLMNB_DISPLAY_NAME,
        help=f"Display name (default: {LLMNB_DISPLAY_NAME}).",
    )


def run(args: argparse.Namespace) -> int:
    ksm = KernelSpecManager()

    if args.action == "show":
        spec = build_kernelspec(display_name=args.display_name)
        print(json.dumps(spec, indent=2))
        return 0

    if args.action == "list":
        specs = ksm.get_all_specs()
        for name, entry in sorted(specs.items()):
            spec = entry.get("spec") or {}
            disp = spec.get("display_name", name)
            lang = spec.get("language", "unknown")
            res = entry.get("resource_dir", "")
            print(f"{name}\t{disp}\t({lang})\t{res}")
        return 0

    if args.action == "uninstall":
        try:
            removed = ksm.remove_kernel_spec(args.name)
        except (NoSuchKernel, KeyError, OSError) as exc:
            print(f"error: failed to uninstall kernelspec {args.name!r}: {exc}", file=sys.stderr)
            return 2
        print(f"uninstalled {args.name} ({removed})")
        return 0

    if args.action == "install":
        spec = build_kernelspec(display_name=args.display_name)
        if args.user:
            user = True
            prefix: Optional[str] = None
        elif args.prefix:
            user = False
            prefix = args.prefix
        else:
            user = False
            prefix = sys.prefix
        try:
            with tempfile.TemporaryDirectory() as tmp:
                kdir = Path(tmp) / args.name
                kdir.mkdir(parents=True, exist_ok=True)
                (kdir / "kernel.json").write_text(
                    json.dumps(spec, indent=2), encoding="utf-8"
                )
                dest = ksm.install_kernel_spec(
                    str(kdir), kernel_name=args.name, user=user, prefix=prefix
                )
        except OSError as exc:
            print(f"error: failed to install kernelspec {args.name!r}: {exc}", file=sys.stderr)
            return 2
        print(f"installed {args.name} -> {dest}")
        return 0

    return 2

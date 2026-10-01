#!/usr/bin/env python3
"""Ask the browser to save its session before stopping its desktop/container."""

import os
from pathlib import Path
import signal
import sys
import time


def process_identity(pid):
    """Return start time, or None for an exited/reaped/reused process."""
    try:
        fields = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else fields[19]
    except (OSError, IndexError):
        return None


def main():
    browsers = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            argv = (entry / 'cmdline').read_bytes().split(b'\0')
            # Renderer and utility processes must stay alive while the primary
            # browser flushes tabs, cookies, and its clean-exit marker.
            if (entry / 'comm').read_text().strip() != 'chrome' or any(
                argument.startswith(b'--type=') for argument in argv
            ):
                continue
            pid = int(entry.name)
            identity = process_identity(pid)
            if identity is None:
                continue
            os.kill(pid, signal.SIGINT)
            browsers[pid] = identity
        except (ProcessLookupError, FileNotFoundError):
            continue

    deadline = time.monotonic() + 20
    while browsers and time.monotonic() < deadline:
        browsers = {
            pid: identity for pid, identity in browsers.items()
            if process_identity(pid) == identity
        }
        if browsers:
            time.sleep(0.2)

    if browsers:
        print('Chrome did not finish saving within 20 seconds; check for an open exit dialog.', file=sys.stderr)
        return 1
    print('Chrome is stopped after the graceful shutdown request.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

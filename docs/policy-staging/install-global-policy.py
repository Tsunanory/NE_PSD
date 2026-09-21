#!/usr/bin/env python3
"""Install the pre-reviewed staged global policy with a fixed target."""

from hashlib import sha256
from pathlib import Path
import os
import stat
import tempfile

TARGET = Path("/Users/tsunanory/.codex/AGENTS.md")
STAGE = Path(__file__).resolve().parent
SOURCE = STAGE / "global-AGENTS.md"
BACKUP = STAGE / "global-AGENTS.original.md"
EXPECTED = "e75fc4f176deb27e30eaf22de1bc238bf6b7f06827445a3d1908050fdfd458c4"


def digest(data: bytes) -> str:
    return sha256(data).hexdigest()


if TARGET.is_symlink() or SOURCE.is_symlink():
    raise SystemExit("refusing symlink target/source")
original = TARGET.read_bytes()
if digest(original) != EXPECTED:
    if digest(original) == digest(SOURCE.read_bytes()):
        raise SystemExit("already installed: staged source is current target")
    raise SystemExit("global target changed; refusing concurrent overwrite")
staged = SOURCE.read_bytes()
if not staged.startswith(original):
    raise SystemExit("staged source does not preserve original bytes")
BACKUP.write_bytes(original)
before = TARGET.stat()
mode = stat.S_IMODE(before.st_mode)
if digest(TARGET.read_bytes()) != EXPECTED:
    raise SystemExit("global target changed during preflight")
fd, temp_name = tempfile.mkstemp(prefix=".AGENTS.", dir=str(TARGET.parent))
try:
    with os.fdopen(fd, "wb") as handle:
        handle.write(staged)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temp_name, mode)
    current = TARGET.stat()
    if (current.st_ino, current.st_mtime_ns, current.st_size) != (before.st_ino, before.st_mtime_ns, before.st_size):
        raise SystemExit("global target changed concurrently")
    os.replace(temp_name, TARGET)
finally:
    if os.path.exists(temp_name):
        os.unlink(temp_name)
print(f"installed {TARGET} from {SOURCE}; original backup: {BACKUP}")

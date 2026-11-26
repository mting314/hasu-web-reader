#!/usr/bin/env python3
"""Pull the CRI ADX2 sound banks out of the raw-asset dump without unpacking all of it.

`llll-assets-raw.7z` (gs://hasu-web-reader-assets/dump/) is ~20 GB of hashed file names
(`raw/xx/<26 base32 chars>`; the real names live in the game's encrypted on-device catalog).
The banks identify themselves by their first bytes: ACB cue sheets start with "@UTF" and
stream banks with "AFS2". This streams the archive and writes only those files to <outdir>,
keeping the archive's paths. scripts/export_bgm.py reads the result.

Usage: uv run --group data scripts/extract_cri_banks.py <llll-assets-raw.7z> data-inspect/raw-cri
"""

from __future__ import annotations

import sys
from pathlib import Path

import py7zr
from py7zr.io import Py7zIO, WriterFactory

MAGIC = {b"@UTF": "acb", b"AFS2": "awb"}


class SniffWriter(Py7zIO):
    """Buffers a member's first 4 bytes, then either writes it to disk or drops it."""

    def __init__(self, outdir: Path, name: str, kept: list[tuple[str, str, int]]):
        self.outdir, self.name, self.kept = outdir, name, kept
        self.head = b""
        self.fh = None
        self.kind: str | None = None
        self.dropped = False
        self.n = 0

    def write(self, s):
        self.n += len(s)
        if self.fh is not None:
            self.fh.write(s)
        elif not self.dropped:
            self.head += bytes(s)
            if len(self.head) >= 4:
                self.kind = MAGIC.get(self.head[:4])
                if self.kind is None:
                    self.dropped, self.head = True, b""
                else:
                    dest = self.outdir / self.name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    self.fh = open(dest, "wb")
                    self.fh.write(self.head)
        return len(s)

    def read(self, size=None):
        return b""

    def seek(self, offset, whence=0):
        return 0

    def flush(self):
        pass

    def size(self):
        return self.n

    def close(self):
        if self.fh is not None:
            self.fh.close()
            self.fh = None
            self.kept.append((self.name, self.kind or "", self.n))


class SniffFactory(WriterFactory):
    def __init__(self, outdir: Path):
        self.outdir = outdir
        self.kept: list[tuple[str, str, int]] = []

    def create(self, filename):
        return SniffWriter(self.outdir, filename, self.kept)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    archive, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    factory = SniffFactory(outdir)
    with py7zr.SevenZipFile(archive, "r") as z:
        z.extractall(factory=factory)
    counts: dict[str, int] = {}
    for _, kind, _ in factory.kept:
        counts[kind] = counts.get(kind, 0) + 1
    print(f"kept {len(factory.kept)} banks {counts} -> {outdir}")


if __name__ == "__main__":
    main()

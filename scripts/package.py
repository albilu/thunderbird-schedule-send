#!/usr/bin/env python3
"""Build a deterministic, dependency-free Thunderbird XPI."""
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    source = ROOT / "extension"
    manifest = json.loads((source / "manifest.json").read_text())
    output = ROOT / "dist" / f"thunderbird-scheduled-send-{manifest['version']}.xpi"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file() and not any(part.startswith(".") for part in path.relative_to(source).parts):
                info = zipfile.ZipInfo(path.relative_to(source).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes())
    print(f"Built {output.relative_to(ROOT)} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()

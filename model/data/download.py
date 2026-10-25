"""Fetch the public Li-ion ageing datasets used to train the Kutle health model.

Everything lands in model/data/raw/ (gitignored). After the first successful
download of a file its SHA-256 is written to model/data/checksums.json, which is
committed. Later runs verify downloads against that file and stop on a mismatch.

The archives are treated strictly as data. Only files with data extensions
(.mat, .xlsx, .xls, .csv, .txt) are extracted, paths are checked so nothing is
written outside the target folder, and nothing shipped inside an archive is ever
run or imported.

Usage:
    .venv/bin/python data/download.py                # all default sources
    .venv/bin/python data/download.py --only nasa calce
    .venv/bin/python data/download.py --severson-batches 2017-06-30 2018-04-12

If a source cannot be reached the script says so and moves on to the next one.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
CHECKSUMS = HERE / "checksums.json"

DATA_EXTENSIONS = {".mat", ".xlsx", ".xls", ".csv", ".txt"}

NASA_URL = "https://phm-datasets.s3.amazonaws.com/NASA/5.+Battery+Data+Set.zip"

CALCE_BASE = "https://web.calce.umd.edu/batteries/data/"
# CS2 cells: 1.1 Ah LCO prismatic. CX2 cells: 1.35 Ah LCO prismatic.
CALCE_CELLS = [
    "CS2_33", "CS2_34", "CS2_35", "CS2_36", "CS2_37", "CS2_38",
    "CX2_34", "CX2_36", "CX2_37", "CX2_38",
]

# Severson et al. 2019 batches on data.matr.io. Each is a MATLAB v7.3 (HDF5) file.
SEVERSON_BATCHES = {
    "2017-05-12": "https://data.matr.io/1/api/v1/file/5c86c0b5fa2ede00015ddf66/download",  # about 3.0 GB
    "2017-06-30": "https://data.matr.io/1/api/v1/file/5c86bf13fa2ede00015ddd82/download",  # about 2.0 GB
    "2018-04-12": "https://data.matr.io/1/api/v1/file/5c86bd64fa2ede00015ddbb2/download",  # about 3.2 GB
}
DEFAULT_SEVERSON = ["2017-06-30"]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_checksums() -> dict:
    if CHECKSUMS.exists():
        return json.loads(CHECKSUMS.read_text())
    return {}


def save_checksums(sums: dict) -> None:
    # Merge with what is on disk so two runs in parallel do not drop each other's entries.
    merged = load_checksums()
    merged.update(sums)
    CHECKSUMS.write_text(json.dumps(dict(sorted(merged.items())), indent=2) + "\n")


def fetch(url: str, dest: Path, retries: int = 10) -> None:
    """Download url to dest, resuming a partial file when the server allows it."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        have = part.stat().st_size if part.exists() else 0
        req = urllib.request.Request(url, headers={"User-Agent": "kutle-model-fetch/1.0"})
        if have:
            req.add_header("Range", f"bytes={have}-")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                mode = "ab" if have and resp.status == 206 else "wb"
                total = resp.headers.get("Content-Length")
                total = int(total) + (have if mode == "ab" else 0) if total else None
                done = have if mode == "ab" else 0
                last = time.time()
                with open(part, mode) as out:
                    while True:
                        buf = resp.read(1 << 20)
                        if not buf:
                            break
                        out.write(buf)
                        done += len(buf)
                        if time.time() - last > 15:
                            pct = f"{100 * done / total:.0f}%" if total else f"{done >> 20} MB"
                            print(f"    {dest.name}: {pct}", flush=True)
                            last = time.time()
            if total and part.stat().st_size != total:
                raise IOError(f"short read: {part.stat().st_size} of {total} bytes")
            part.rename(dest)
            return
        except (urllib.error.URLError, IOError, TimeoutError) as exc:
            print(f"    attempt {attempt} failed: {exc}", flush=True)
            if attempt == retries:
                raise
            time.sleep(min(30, 5 * attempt))


def safe_extract(zf: zipfile.ZipFile, target: Path, prefix: str = "") -> list[Path]:
    """Extract data files only. Nested zips are opened in memory and handled the same way."""
    out = []
    target = target.resolve()
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename.replace("\\", "/")
        if name.startswith("__MACOSX/") or Path(name).name.startswith("._"):
            continue
        ext = Path(name).suffix.lower()
        if ext == ".zip":
            with zf.open(info) as inner_raw:
                inner = zipfile.ZipFile(io.BytesIO(inner_raw.read()))
            out += safe_extract(inner, target, prefix + Path(name).stem + "/")
            continue
        if ext not in DATA_EXTENSIONS:
            continue
        dest = (target / (prefix + name)).resolve()
        if os.path.commonpath([str(dest), str(target)]) != str(target):
            print(f"    skipping suspicious path {name!r}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(dest, "wb") as dst:
            while True:
                buf = src.read(1 << 20)
                if not buf:
                    break
                dst.write(buf)
        out.append(dest)
    return out


def get_file(key: str, url: str, dest: Path, sums: dict) -> bool:
    """Download (if needed) and verify one file. Returns True when it is usable."""
    if not dest.exists():
        print(f"  downloading {key} from {url}", flush=True)
        try:
            fetch(url, dest)
        except Exception as exc:  # report and continue with other sources
            print(f"  UNREACHABLE: {key} ({exc}). Continuing without it.", flush=True)
            return False
    digest = sha256_of(dest)
    if key in sums and sums[key] != digest:
        print(f"  CHECKSUM MISMATCH for {key}: expected {sums[key]}, got {digest}. Not using it.")
        return False
    if key not in sums:
        sums[key] = digest
        save_checksums(sums)
        print(f"  recorded sha256 {digest[:16]}... for {key}")
    else:
        print(f"  verified {key}")
    return True


def do_nasa(sums: dict) -> None:
    print("NASA PCoE battery data set")
    archive = RAW / "archives" / "nasa_battery_data_set.zip"
    if not get_file("nasa/5_Battery_Data_Set.zip", NASA_URL, archive, sums):
        return
    target = RAW / "nasa"
    if not any(target.rglob("*.mat")):
        with zipfile.ZipFile(archive) as zf:
            files = safe_extract(zf, target)
        print(f"  extracted {len(files)} data files to {target}")


def do_calce(sums: dict, cells: list[str]) -> None:
    print("CALCE CS2 / CX2")
    for cell in cells:
        archive = RAW / "archives" / f"calce_{cell}.zip"
        if not get_file(f"calce/{cell}.zip", CALCE_BASE + f"{cell}.zip", archive, sums):
            continue
        target = RAW / "calce" / cell
        if not target.exists() or not any(target.rglob("*.xls*")):
            with zipfile.ZipFile(archive) as zf:
                files = safe_extract(zf, target)
            print(f"  extracted {len(files)} files for {cell}")


def do_severson(sums: dict, batches: list[str]) -> None:
    print("Severson et al. 2019 (data.matr.io)")
    for b in batches:
        url = SEVERSON_BATCHES[b]
        dest = RAW / "severson" / f"{b}_batchdata_updated_struct_errorcorrect.mat"
        get_file(f"severson/{b}.mat", url, dest, sums)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", choices=["nasa", "calce", "severson"], default=None)
    ap.add_argument("--calce-cells", nargs="*", choices=CALCE_CELLS, default=CALCE_CELLS)
    ap.add_argument("--severson-batches", nargs="*", choices=sorted(SEVERSON_BATCHES), default=DEFAULT_SEVERSON)
    args = ap.parse_args(argv)
    which = args.only or ["nasa", "calce", "severson"]
    RAW.mkdir(parents=True, exist_ok=True)
    sums = load_checksums()
    if "nasa" in which:
        do_nasa(sums)
    if "calce" in which:
        do_calce(sums, args.calce_cells)
    if "severson" in which:
        do_severson(sums, args.severson_batches)
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Reader for the CALCE CS2 / CX2 Arbin exports (.xlsx and .xls).

Each cell comes as a folder of workbooks, one per test session. Every workbook
has an "Info" sheet and one or more "Channel_*" sheets with the raw log
(Cycle_Index, Current, Voltage, Charge/Discharge capacity and energy,
Internal_Resistance). Some also carry a "Statistics_*" sheet, but not all of
them do, so the raw log is used throughout.

Per Arbin convention the capacity and energy counters accumulate within a
session, so per-cycle values are taken as max minus min of the counter inside
the cycle. Sessions are ordered by their first timestamp and cycles are
numbered consecutively across sessions.

There is no cell temperature in these files, so the temperature features are
left missing for CALCE.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import numpy as np

from .features import CellRecord

COLS = {
    "cycle": "Cycle_Index",
    "time": "Date_Time",
    "current": "Current(A)",
    "voltage": "Voltage(V)",
    "qd": "Discharge_Capacity(Ah)",
    "ed": "Discharge_Energy(Wh)",
    "ir": "Internal_Resistance(Ohm)",
}


def _rows_xlsx(path: Path):
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        for ws in wb.worksheets:
            if not ws.title.startswith("Channel"):
                continue
            it = ws.iter_rows(values_only=True)
            header = next(it, None)
            if header is None:
                continue
            yield [str(h).strip() if h is not None else "" for h in header], it
    finally:
        wb.close()


def _rows_xls(path: Path):
    import xlrd

    book = xlrd.open_workbook(str(path), on_demand=True)
    try:
        for name in book.sheet_names():
            if not name.startswith("Channel"):
                continue
            sh = book.sheet_by_name(name)
            if sh.nrows < 2:
                continue
            header = [str(h).strip() for h in sh.row_values(0)]

            def gen(sh=sh, datemode=book.datemode):
                for r in range(1, sh.nrows):
                    yield sh.row_values(r)

            yield header, gen()
    finally:
        book.release_resources()


def _read_session(path: Path) -> dict | None:
    reader = _rows_xls if path.suffix.lower() == ".xls" else _rows_xlsx
    data = {k: [] for k in COLS}
    found = False
    for header, rows in reader(path):
        try:
            idx = {k: header.index(v) for k, v in COLS.items()}
        except ValueError:
            continue
        found = True
        for row in rows:
            for k, j in idx.items():
                data[k].append(row[j] if j < len(row) else None)
    if not found or not data["cycle"]:
        return None
    t0 = data["time"][0]
    if isinstance(t0, (int, float)):
        start = float(t0)
    elif isinstance(t0, datetime):
        start = t0.timestamp()
    else:
        start = float("inf")
    out = {"start": start}
    for k in ("cycle", "current", "voltage", "qd", "ed", "ir"):
        out[k] = np.array([np.nan if v in (None, "") else float(v) for v in data[k]], dtype=float)
    return out


def _session_cycles(s: dict, rated_ah: float) -> list[dict]:
    out = []
    cyc = s["cycle"]
    for c in np.unique(cyc[np.isfinite(cyc)]):
        m = cyc == c
        i, v = s["current"][m], s["voltage"][m]
        qd, ed, ir = s["qd"][m], s["ed"][m], s["ir"][m]
        dis = i < -0.05
        if dis.sum() < 10:
            continue
        q = np.nanmax(qd) - np.nanmin(qd)
        e = np.nanmax(ed) - np.nanmin(ed)
        # Only full discharges: the voltage has to reach the cut-off region.
        if not np.isfinite(q) or q <= 0 or np.nanmin(v[dis]) > 2.9:
            continue
        chg = i > 0.05
        irv = ir[np.isfinite(ir) & (ir > 0) & (ir < 1.0)]
        out.append({
            "cap": q,
            "vmean": e / q if e > 0 else np.nan,
            "ir": float(np.median(irv)) if irv.size else np.nan,
            "dis_c": float(np.median(np.abs(i[dis]))) / rated_ah,
            "chg_c": float(np.percentile(i[chg], 90)) / rated_ah if chg.sum() > 10 else np.nan,
        })
    return out


def read_calce_cell(folder: Path, cell_id: str, rated_ah: float) -> CellRecord | None:
    files = sorted(p for p in folder.rglob("*") if p.suffix.lower() in (".xlsx", ".xls") and not p.name.startswith("~$"))
    sessions = []
    for p in files:
        s = _read_session(p)
        if s is not None:
            sessions.append(s)
    sessions.sort(key=lambda s: s["start"])
    cycles = []
    for s in sessions:
        cycles += _session_cycles(s, rated_ah)
    if not cycles:
        return None
    family = cell_id[:3]
    return CellRecord(
        dataset="calce",
        cell_id=cell_id,
        rated_ah=rated_ah,
        chemistry=f"LCO/graphite prismatic ({family}, {rated_ah} Ah)",
        capacity_ah=np.array([c["cap"] for c in cycles]),
        resistance_ohm=np.array([c["ir"] for c in cycles]),
        t_mean_cycle=np.full(len(cycles), np.nan),
        t_max_cycle=np.full(len(cycles), np.nan),
        v_mean_dis=np.array([c["vmean"] for c in cycles]),
        chg_c=np.array([c["chg_c"] for c in cycles]),
        dis_c=np.array([c["dis_c"] for c in cycles]),
        ambient_c=25.0,
    )

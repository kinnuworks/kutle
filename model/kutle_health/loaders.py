"""Readers for the raw datasets, producing one CellRecord per cell.

The readers only parse numeric arrays out of .mat / .xlsx / .xls files. They
never run anything that ships with a dataset.

Cleaning is deliberately simple and the same for every dataset:
  * discharge capacities outside 30% to 120% of rating are dropped,
  * a capacity more than 8% away from the centered 9-cycle median is dropped
    as a measurement glitch,
  * cells with fewer than 40 cycles left after cleaning are skipped.
"""

from __future__ import annotations

import pickle
import re
from pathlib import Path

import numpy as np

from .features import CellRecord

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
CACHE = RAW / "processed"
MIN_CYCLES = 40


def _clean(rec: CellRecord) -> CellRecord | None:
    soh = rec.capacity_ah / rec.rated_ah
    keep = (soh > 0.3) & (soh < 1.2) & np.isfinite(soh)
    idx = np.nonzero(keep)[0]
    if idx.size < MIN_CYCLES:
        return None
    s = soh[idx]
    med = np.array([np.median(s[max(0, i - 4): i + 5]) for i in range(len(s))])
    good = np.abs(s - med) <= 0.08 * med
    idx = idx[good]
    if idx.size < MIN_CYCLES:
        return None
    return CellRecord(
        dataset=rec.dataset,
        cell_id=rec.cell_id,
        rated_ah=rec.rated_ah,
        chemistry=rec.chemistry,
        capacity_ah=rec.capacity_ah[idx],
        resistance_ohm=rec.resistance_ohm[idx],
        t_mean_cycle=rec.t_mean_cycle[idx],
        t_max_cycle=rec.t_max_cycle[idx],
        v_mean_dis=rec.v_mean_dis[idx],
        chg_c=rec.chg_c[idx],
        dis_c=rec.dis_c[idx],
        cycle=rec.cycle[idx],
        ambient_c=rec.ambient_c,
        first_soh=float(soh[idx[0]]),
    )


def _cached(name: str, builder):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{name}.pkl"
    if path.exists():
        with open(path, "rb") as f:
            return pickle.load(f)
    recs = builder()
    with open(path, "wb") as f:
        pickle.dump(recs, f)
    return recs


# --------------------------------------------------------------------- NASA

NASA_RATED_AH = 2.0


def _nasa_cell(path: Path) -> CellRecord | None:
    from scipy.io import loadmat

    name = path.stem
    mat = loadmat(path, squeeze_me=True, struct_as_record=False)
    if name not in mat:
        return None
    cycles = np.atleast_1d(mat[name].cycle)
    cap, res, tmean, tmax, vmean, chg, dis = [], [], [], [], [], [], []
    ambients = []
    pending_r = np.nan
    chg_since = np.nan
    for c in cycles:
        kind = str(c.type).strip()
        d = c.data
        try:
            ambients.append(float(c.ambient_temperature))
        except Exception:
            pass
        if kind == "impedance":
            try:
                r = float(np.real(d.Re)) + float(np.real(d.Rct))
            except Exception:
                r = np.nan
            if np.isfinite(r) and 0.0 < r < 1.0:
                pending_r = r
        elif kind == "charge":
            i = np.atleast_1d(np.asarray(d.Current_measured, dtype=float))
            if i.size > 10:
                # 90th percentile skips the short spikes at the start of a charge
                m = float(np.nanpercentile(np.abs(i), 90))
                chg_since = m if np.isnan(chg_since) else max(chg_since, m)
        elif kind == "discharge":
            capv = np.atleast_1d(np.asarray(getattr(d, "Capacity", np.nan), dtype=float))
            if capv.size == 0 or not np.isfinite(capv[0]):
                continue
            v = np.atleast_1d(np.asarray(d.Voltage_measured, dtype=float))
            i = np.atleast_1d(np.asarray(d.Current_measured, dtype=float))
            t = np.atleast_1d(np.asarray(d.Time, dtype=float))
            temp = np.atleast_1d(np.asarray(d.Temperature_measured, dtype=float))
            on = np.abs(i) > 0.1
            if on.sum() < 5:
                continue
            dt = np.diff(t, prepend=t[0])
            w = dt * np.abs(i) * on
            cap.append(float(capv[0]))
            vmean.append(float(np.sum(v * w) / np.sum(w)) if np.sum(w) > 0 else np.nan)
            tmean.append(float(np.mean(temp)))
            tmax.append(float(np.max(temp)))
            dis.append(float(np.median(np.abs(i[on]))) / NASA_RATED_AH)
            chg.append(chg_since / NASA_RATED_AH if np.isfinite(chg_since) else np.nan)
            # A resistance reading is attributed to the first discharge after it.
            res.append(pending_r)
            pending_r = np.nan
    if not cap:
        return None
    rec = CellRecord(
        dataset="nasa",
        cell_id=name,
        rated_ah=NASA_RATED_AH,
        chemistry="18650 Li-ion (LCO family, per NASA PCoE description)",
        capacity_ah=np.array(cap),
        resistance_ohm=np.array(res),
        t_mean_cycle=np.array(tmean),
        t_max_cycle=np.array(tmax),
        v_mean_dis=np.array(vmean),
        chg_c=np.array(chg),
        dis_c=np.array(dis),
        ambient_c=float(np.median(ambients)) if ambients else float("nan"),
    )
    return _clean(rec)


def load_nasa() -> list[CellRecord]:
    def build():
        files = sorted((RAW / "nasa").rglob("B00*.mat"))
        seen, out = set(), []
        for p in files:
            if p.stem in seen:
                continue
            seen.add(p.stem)
            rec = _nasa_cell(p)
            if rec is not None:
                out.append(rec)
        return out

    if not (RAW / "nasa").exists():
        return []
    return _cached("nasa", build)


# --------------------------------------------------------------- Severson

SEVERSON_RATED_AH = 1.1
# Batch 2017-06-30 cells that continue batch 2017-05-12 cells. Their cycle
# counter restarts, so their history is not self-contained; Severson et al.
# drop them as standalone cells too.
SEVERSON_CONTINUATIONS = {"2017-06-30": {7, 8, 9, 15, 16}}


def _h5str(f, ref) -> str:
    arr = f[ref][()]
    return "".join(chr(int(c)) for c in np.asarray(arr).ravel())


def _policy_max_c(policy: str) -> float:
    rates = [float(x.replace("_", ".")) for x in re.findall(r"(\d+(?:[._]\d+)?)C", policy)]
    return max(rates) if rates else np.nan


def _severson_batch(path: Path) -> list[CellRecord]:
    import h5py

    batch_name = path.name[:10]
    skip = SEVERSON_CONTINUATIONS.get(batch_name, set())
    out = []
    with h5py.File(path, "r") as f:
        b = f["batch"]
        n = b["summary"].shape[0]
        for i in range(n):
            if i in skip:
                continue
            try:
                policy = _h5str(f, b["policy_readable"][i, 0])
            except Exception:
                policy = ""
            summ = f[b["summary"][i, 0]]
            qd = summ["QDischarge"][()].ravel()
            ir = summ["IR"][()].ravel()
            tavg = summ["Tavg"][()].ravel()
            tmx = summ["Tmax"][()].ravel()
            cyc_no = summ["cycle"][()].ravel()
            cyc = f[b["cycles"][i, 0]]
            ncyc = min(len(qd), cyc["V"].shape[0])
            vmean = np.full(ncyc, np.nan)
            for j in range(ncyc):
                try:
                    v = f[cyc["V"][j, 0]][()].ravel()
                    q = f[cyc["Qd"][j, 0]][()].ravel()
                    cur = f[cyc["I"][j, 0]][()].ravel()
                except Exception:
                    continue
                if v.size < 10 or v.size != q.size or v.size != cur.size:
                    continue
                dq = np.diff(q)
                mask = (cur[1:] < -0.5) & (dq > 0)
                if mask.sum() > 5:
                    vmean[j] = float(np.sum(v[1:][mask] * dq[mask]) / np.sum(dq[mask]))
            qd, ir, tavg, tmx, cyc_no = qd[:ncyc], ir[:ncyc], tavg[:ncyc], tmx[:ncyc], cyc_no[:ncyc]
            ir = np.where(ir > 0, ir, np.nan)
            chg = _policy_max_c(policy)
            rec = CellRecord(
                dataset="severson",
                cell_id=f"{batch_name}_c{i}",
                rated_ah=SEVERSON_RATED_AH,
                chemistry="LFP/graphite A123 APR18650M1A",
                capacity_ah=qd,
                resistance_ohm=ir,
                t_mean_cycle=tavg,
                t_max_cycle=tmx,
                v_mean_dis=vmean,
                chg_c=np.full(ncyc, chg),
                dis_c=np.full(ncyc, 4.0),
                cycle=np.where(cyc_no > 0, cyc_no, np.arange(1, ncyc + 1)).astype(float),
            )
            # Cycle numbers must increase for the lag features.
            order = np.argsort(rec.cycle, kind="mergesort")
            if np.any(order != np.arange(ncyc)):
                continue
            cleaned = _clean(rec)
            if cleaned is not None:
                out.append(cleaned)
    return out


def load_severson() -> list[CellRecord]:
    files = sorted((RAW / "severson").glob("*.mat"))
    if not files:
        return []

    def build():
        out = []
        for p in files:
            out += _severson_batch(p)
        return out

    return _cached("severson_" + "_".join(p.name[:10] for p in files), build)


# ------------------------------------------------------------------ CALCE

CALCE_RATED_AH = {"CS2": 1.1, "CX2": 1.35}


def load_calce() -> list[CellRecord]:
    from .calce import read_calce_cell

    root = RAW / "calce"
    if not root.exists():
        return []

    def build():
        out = []
        for d in sorted(p for p in root.iterdir() if p.is_dir()):
            family = d.name[:3]
            rec = read_calce_cell(d, d.name, CALCE_RATED_AH[family])
            if rec is not None:
                rec = _clean(rec)
            if rec is not None:
                out.append(rec)
        return out

    return _cached("calce", build)


LOADERS = {"nasa": load_nasa, "calce": load_calce, "severson": load_severson}

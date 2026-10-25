"""Per-cycle features that a field fuel gauge could provide.

Each lab cell is reduced to one row per discharge cycle. Features only use data
from the current and earlier cycles, so they match what a device sitting next to
the gauge would know at that moment. Labels (state of health and remaining
useful life) may use later cycles because they are the ground truth.

Mapping from each feature to where a TI bq40z651 (as in the MacBook Air pack)
would supply it. Register numbers follow the public bq40z50 family technical
reference; the bq40z651 reference is not public, so confirm the numbers against
it before relying on them in firmware.

    cycle        SBS CycleCount() 0x17. Apple exposes it as CycleCount.
    efc          Equivalent full cycles: charge discharged so far divided by
                 rated capacity. In the lab it is the running sum of
                 (capacity / rating) over cycles, counting skipped cycle
                 numbers at the last known capacity. A gauge's CycleCount is
                 itself a charge-throughput counter (it increments each time
                 the accumulated discharge passes the CC Threshold in data
                 flash), so on a pack CycleCount is the field value for efc.
    r_ratio      Impedance Track Ra table (data flash, R_a0..R_a14 per cell),
                 divided by the value at first use. Apple exposes a per-cell
                 WeightedRa and the Ra00..Ra14 table. The first-use value has to
                 be stored by the passport device at issue; for packs read cold
                 it is an assumption and the script reports it as such.
    t_mean       Lifetime average cell temperature. Apple exposes
                 LifetimeData.AverageTemperature; TI parts keep time-in-range
                 counters in the lifetime data blocks from which an average can
                 be formed. Lab value: running mean of per-cycle mean cell
                 temperature.
    t_max        Lifetime maximum cell temperature, LifetimeDataBlock1
                 (ManufacturerBlockAccess 0x0060), Max Temp Cell. Apple:
                 LifetimeData.MaximumTemperature.
    dv_mean_dis  Change in mean discharge voltage since first use, in mV. Formed
                 by the passport device from logged SBS Voltage() 0x09 and
                 Current() 0x0A over a discharge (energy / charge). Not
                 available from a single snapshot.
    chg_c_max    Lifetime maximum charge current (LifetimeDataBlock1, Max
                 Charge Current) divided by SBS DesignCapacity() 0x18.
    dis_c_max    Lifetime maximum discharge current (LifetimeDataBlock1, Max
                 Discharge Current) divided by DesignCapacity().

Extra inputs for the remaining useful life models:

    soh_now      Measured capacity over design capacity:
                 SBS FullChargeCapacity() 0x10 / DesignCapacity() 0x18
                 (Apple: AppleRawMaxCapacity / DesignCapacity).
    fade_life    Average fade since new, (1 - soh_now) * 100 / cycle, in SoH
                 points per 100 cycles. Needs only the two registers above.
    fade_recent  Fade over the last 50 cycles in points per 100 cycles. Needs a
                 capacity history, which the passport device builds up over time.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

SOH_FEATURES = ["cycle", "r_ratio", "t_mean", "t_max", "dv_mean_dis", "chg_c_max", "dis_c_max"]
RUL_EXTRA = ["soh_now", "fade_life", "fade_recent"]
COUNTERS = ["cycle", "efc"]
RUL_FEATURES = SOH_FEATURES + RUL_EXTRA

# Features that may be missing in the field, in groups that go missing together.
GROUPS = {
    "res": ["r_ratio"],
    "temp": ["t_mean", "t_max"],
    "volt": ["dv_mean_dis"],
    "hist": ["fade_recent"],
}

RECENT_WINDOW = 50


@dataclass
class CellRecord:
    dataset: str
    cell_id: str
    rated_ah: float
    chemistry: str
    capacity_ah: np.ndarray  # one value per discharge cycle
    resistance_ohm: np.ndarray  # NaN where not measured on that cycle
    t_mean_cycle: np.ndarray  # per-cycle mean cell temperature, degC (NaN if unknown)
    t_max_cycle: np.ndarray  # per-cycle max cell temperature, degC
    v_mean_dis: np.ndarray  # per-cycle mean discharge voltage, V
    chg_c: np.ndarray  # per-cycle max charge rate in C
    dis_c: np.ndarray  # per-cycle discharge rate in C
    cycle: np.ndarray = field(default=None)  # cycle numbers; defaults to 1..N
    ambient_c: float = float("nan")  # chamber temperature of the test, if reported
    first_soh: float = float("nan")  # capacity / rating on the first recorded cycle, before cleaning

    def __post_init__(self):
        n = len(self.capacity_ah)
        if self.cycle is None:
            self.cycle = np.arange(1, n + 1, dtype=float)
        for name in ("resistance_ohm", "t_mean_cycle", "t_max_cycle", "v_mean_dis", "chg_c", "dis_c", "cycle"):
            arr = np.asarray(getattr(self, name), dtype=float)
            if arr.shape != (n,):
                raise ValueError(f"{self.cell_id}: {name} has shape {arr.shape}, expected ({n},)")
            setattr(self, name, arr)
        self.capacity_ah = np.asarray(self.capacity_ah, dtype=float)


def _trailing_median(x: np.ndarray, window: int) -> np.ndarray:
    """Median of the last `window` valid values up to each index (causal)."""
    out = np.full_like(x, np.nan, dtype=float)
    buf: list[float] = []
    for i, v in enumerate(x):
        if not np.isnan(v):
            buf.append(v)
            if len(buf) > window:
                buf.pop(0)
        if buf:
            out[i] = float(np.median(buf))
    return out


def _first_valid_median(x: np.ndarray, k: int = 5) -> float:
    v = x[~np.isnan(x)][:k]
    return float(np.median(v)) if v.size else float("nan")


def centered_median(x: np.ndarray, window: int = 5) -> np.ndarray:
    """Centered rolling median, used for labels only (it looks ahead)."""
    h = window // 2
    n = len(x)
    return np.array([np.nanmedian(x[max(0, i - h): min(n, i + h + 1)]) for i in range(n)])


def _expanding(x: np.ndarray, fn) -> np.ndarray:
    out = np.full_like(x, np.nan, dtype=float)
    acc = None
    count = 0
    for i, v in enumerate(x):
        if not np.isnan(v):
            if fn == "mean":
                acc = v if acc is None else acc + (v - acc) / (count + 1)
                count += 1
            else:
                acc = v if acc is None else max(acc, v)
        if acc is not None:
            out[i] = acc
    return out


def cycles_to_threshold(cycle: np.ndarray, soh_smooth: np.ndarray, threshold: float) -> np.ndarray:
    """Remaining cycles until the smoothed SoH first drops below threshold.

    NaN where the crossing is never observed (censored) or already happened.
    """
    below = np.nonzero(soh_smooth < threshold)[0]
    rul = np.full_like(cycle, np.nan, dtype=float)
    if below.size == 0:
        return rul
    j = below[0]
    rul[:j] = cycle[j] - cycle[:j]
    return rul


def cell_features(rec: CellRecord) -> dict[str, np.ndarray]:
    """All features and labels for one cell, one entry per discharge cycle."""
    soh = rec.capacity_ah / rec.rated_ah
    r_s = _trailing_median(rec.resistance_ohm, 5)
    r0 = _first_valid_median(rec.resistance_ohm)
    v_s = _trailing_median(rec.v_mean_dis, 5)
    v0 = _first_valid_median(rec.v_mean_dis)
    soh_causal = _trailing_median(soh, 5)
    lagged = np.full_like(soh, np.nan)
    idx = np.searchsorted(rec.cycle, rec.cycle - RECENT_WINDOW, side="left")
    ok = rec.cycle - rec.cycle[0] >= RECENT_WINDOW
    lagged[ok] = soh_causal[idx[ok]]
    soh_smooth = centered_median(soh, 5)
    gaps = np.diff(rec.cycle, prepend=0.0)
    efc = np.cumsum(soh * gaps)
    return {
        "cycle": rec.cycle.copy(),
        "efc": efc,
        "r_ratio": r_s / r0 if np.isfinite(r0) and r0 > 0 else np.full_like(soh, np.nan),
        "t_mean": _expanding(rec.t_mean_cycle, "mean"),
        "t_max": _expanding(rec.t_max_cycle, "max"),
        "dv_mean_dis": (v_s - v0) * 1000.0 if np.isfinite(v0) else np.full_like(soh, np.nan),
        "chg_c_max": _expanding(rec.chg_c, "max"),
        "dis_c_max": _expanding(rec.dis_c, "max"),
        "soh_now": soh.copy(),
        "fade_life": (1.0 - soh) * 100.0 / np.maximum(rec.cycle, 1.0),
        "fade_life_efc": (1.0 - soh) * 100.0 / np.maximum(efc, 1.0),
        "fade_recent": (lagged - soh_causal) * 100.0 / RECENT_WINDOW,
        # labels
        "y_soh": soh,
        "y_rul80": cycles_to_threshold(rec.cycle, soh_smooth, 0.80),
        "y_rul60": cycles_to_threshold(rec.cycle, soh_smooth, 0.60),
    }


def build_table(records: list[CellRecord]):
    """Stack all cells into one pandas DataFrame with dataset and cell columns."""
    import pandas as pd

    frames = []
    for rec in records:
        feats = cell_features(rec)
        df = pd.DataFrame(feats)
        df.insert(0, "cell", f"{rec.dataset}/{rec.cell_id}")
        df.insert(0, "dataset", rec.dataset)
        df["chemistry"] = rec.chemistry
        df["ambient_c"] = rec.ambient_c
        df["first_soh"] = rec.first_soh
        frames.append(df)
    return pd.concat(frames, ignore_index=True)

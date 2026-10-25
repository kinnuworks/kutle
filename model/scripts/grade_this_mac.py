"""Grade this Mac's battery with both Kutle SoH methods.

Reads the pack through `ioreg -r -c AppleSmartBattery -a` (read only) and runs
the same pure Python inference the passport system uses:

  * the learned model (kutle-soh-learned-v2), which predicts SoH from the cycle
    counter and resistance growth without seeing the measured capacity;
  * the measured method (kutle-soh-measured-v1), which takes the gauge's
    capacity over design capacity and widens it for gauge accuracy and for how
    many cycles ago Qmax was last updated (CycleCount - CycleCountLastQmax).

It prints both intervals, the grade each would get under
PassportRegistry.gradeFor, the consistency flag (measured SoH outside the
learned interval), and the interval the combined grader would submit: the
measured one when the Qmax update is fresh, otherwise the learned one.

Usage:
    .venv/bin/python scripts/grade_this_mac.py
    .venv/bin/python scripts/grade_this_mac.py --r0-mohm 45     # first-use WeightedRa, if known
    .venv/bin/python scripts/grade_this_mac.py --ioreg-plist saved.plist
    .venv/bin/python scripts/grade_this_mac.py --json
"""

from __future__ import annotations

import argparse
import json
import plistlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from kutle_health import inference  # noqa: E402

MODEL = ROOT / "artifacts" / "model.json"
MEASURED = ROOT / "artifacts" / "measured_method.json"

# Without a stored first-use resistance the growth ratio is unknown. Training
# cells reach a ratio of about 1.1 to 1.3 by the time they are at 80% SoH. A
# laptop cell read cold, with no record of its starting value, could plausibly
# be anywhere from 1.0 to 1.5, so the script sweeps that range and reports the
# envelope of the learned intervals. Values above the training range are
# flagged as out of distribution.
DEFAULT_R_RATIO_RANGE = [1.0 + 0.05 * i for i in range(11)]


def read_ioreg(plist_path: str | None) -> dict:
    if plist_path:
        raw = Path(plist_path).read_bytes()
    else:
        raw = subprocess.check_output(["ioreg", "-r", "-c", "AppleSmartBattery", "-a"])
    items = plistlib.loads(raw)
    if not items:
        raise SystemExit("no AppleSmartBattery entry found; is this a Mac laptop?")
    return items[0]


def signed(x: int) -> int:
    """ioreg sometimes prints negative currents as unsigned 64-bit values."""
    return x - (1 << 64) if x >= (1 << 63) else x


def gauge_snapshot(d: dict) -> dict:
    bd = d.get("BatteryData", {})
    life = bd.get("LifetimeData", {})
    design = int(d.get("DesignCapacity") or bd.get("DesignCapacity"))
    avg_t = life.get("AverageTemperature")
    # AverageTemperature is reported in tenths of a degree on this machine
    # (for example 267 for 26.7 C) while Max/MinimumTemperature are whole degrees.
    if avg_t is not None and avg_t > 100:
        avg_t = avg_t / 10.0
    last_qmax = life.get("CycleCountLastQmax", bd.get("CycleCountLastQmax"))
    return {
        "device": d.get("DeviceName"),
        "cycle_count": int(d.get("CycleCount")),
        "cycle_count_last_qmax": int(last_qmax) if last_qmax is not None else None,
        "design_capacity_mah": design,
        "raw_max_capacity_mah": int(d.get("AppleRawMaxCapacity")),
        "design_cycle_count": d.get("DesignCycleCount9C"),
        "temperature_c": (d.get("Temperature") or 0) / 100.0,
        "cell_voltage_mv": bd.get("CellVoltage"),
        "qmax_mah": bd.get("Qmax"),
        "weighted_ra": bd.get("WeightedRa"),
        "life_avg_temp_c": avg_t,
        "life_max_temp_c": life.get("MaximumTemperature"),
        "life_max_charge_ma": signed(int(life["MaximumChargeCurrent"])) if "MaximumChargeCurrent" in life else None,
        "life_max_discharge_ma": signed(int(life["MaximumDischargeCurrent"])) if "MaximumDischargeCurrent" in life else None,
        "chem_id": bd.get("ChemID"),
    }


def inputs_for(s: dict, r_ratio: float | None) -> dict:
    design = s["design_capacity_mah"]
    n_since = (s["cycle_count"] - s["cycle_count_last_qmax"]) if s["cycle_count_last_qmax"] is not None else None
    return {
        # CycleCount is a charge-throughput counter, so it serves for both counters.
        "cycle": float(s["cycle_count"]),
        "efc": float(s["cycle_count"]),
        "r_ratio": r_ratio,
        "t_mean": s["life_avg_temp_c"],
        "t_max": float(s["life_max_temp_c"]) if s["life_max_temp_c"] is not None else None,
        "dv_mean_dis": None,  # needs a logged discharge
        "chg_c_max": abs(s["life_max_charge_ma"]) / design if s["life_max_charge_ma"] else None,
        "dis_c_max": abs(s["life_max_discharge_ma"]) / design if s["life_max_discharge_ma"] else None,
        "fade_recent": None,  # needs capacity history
        # Full charge capacity from Impedance Track (derived from Qmax and resistance).
        "soh_measured": s["raw_max_capacity_mah"] / design,
        "cycles_since_update": float(n_since) if n_since is not None else None,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=str(MODEL))
    ap.add_argument("--measured", default=str(MEASURED))
    ap.add_argument("--ioreg-plist", default=None, help="read a saved `ioreg -a` plist instead of the live gauge")
    ap.add_argument("--r0-mohm", type=float, default=None,
                    help="WeightedRa at first use (mean over cells), if the passport device stored it")
    ap.add_argument("--json", action="store_true", help="print machine-readable output only")
    args = ap.parse_args(argv)

    model = inference.load(args.model)
    params = inference.load(args.measured)
    snap = gauge_snapshot(read_ioreg(args.ioreg_plist))
    wra = snap["weighted_ra"] or []
    ra_now = sum(wra) / len(wra) if wra else None

    if args.r0_mohm and ra_now:
        ratios = [ra_now / args.r0_mohm]
        r_note = f"r_ratio = mean WeightedRa {ra_now:.1f} / stored first-use {args.r0_mohm:.1f} = {ratios[0]:.2f}"
    elif ra_now:
        ratios = DEFAULT_R_RATIO_RANGE
        r_note = (f"no first-use resistance stored; swept r_ratio from {ratios[0]:.2f} to {ratios[-1]:.2f} "
                  f"and took the envelope (mean WeightedRa now {ra_now:.1f})")
    else:
        ratios = [None]
        r_note = "no resistance data; resistance treated as missing"

    runs = [inference.combined(model, params, inputs_for(snap, r)) for r in ratios]
    mid = runs[len(runs) // 2]
    l_low = min(r["learned"]["soh_low_bps"] for r in runs)
    l_high = max(r["learned"]["soh_high_bps"] for r in runs)
    l_grade = inference.grade_for(l_low, l_high)
    meas = mid["measured"]
    consistent = None if meas is None else (l_low <= meas["measured_bps"] <= l_high)
    use_measured = meas is not None and meas["fresh"]
    final_low, final_high = (meas["soh_low_bps"], meas["soh_high_bps"]) if use_measured else (l_low, l_high)
    final_grade = inference.grade_for(final_low, final_high)

    def env(key):
        return (min(r["learned"][key + "_low"] for r in runs), mid["learned"][key],
                max(r["learned"][key + "_high"] for r in runs))

    rul80, rul60 = env("rul80"), env("rul60")
    ood = sorted({n for r in runs for n in r["learned"]["soh_ood"]})
    qmax_soh = None
    if snap["qmax_mah"]:
        qmax_soh = sum(snap["qmax_mah"]) / len(snap["qmax_mah"]) / snap["design_capacity_mah"]

    result = {
        "gauge": snap,
        "r_ratio_note": r_note,
        "learned": {"soh_bps": mid["learned"]["soh_bps"], "interval_bps": [l_low, l_high],
                    "grade": inference.GRADE_NAMES[l_grade], "inputs_outside_training_range": ood},
        "measured": None if meas is None else {
            "soh_bps": meas["soh_bps"], "measured_bps": meas["measured_bps"],
            "interval_bps": [meas["soh_low_bps"], meas["soh_high_bps"]],
            "cycles_since_qmax_update": meas["cycles_since_update"], "fresh": meas["fresh"],
            "grade": meas["grade_name"]},
        "consistent": consistent,
        "submitted": {"source": "measured" if use_measured else "learned",
                      "interval_bps": [final_low, final_high], "grade": inference.GRADE_NAMES[final_grade]},
        "rul80_cycles": {"low": rul80[0], "point": rul80[1], "high": rul80[2]},
        "rul60_cycles": {"low": rul60[0], "point": rul60[1], "high": rul60[2]},
    }
    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    s = snap
    pct = lambda b: f"{b / 100:.1f}%"  # noqa: E731
    print("Kutle battery health check, this Mac")
    print("")
    print(f"Gauge            {s['device']}  ChemID {s['chem_id']}  {len(s['cell_voltage_mv'] or [])} cells "
          f"{s['cell_voltage_mv']} mV")
    print(f"Cycle count      {s['cycle_count']} (last Qmax update at cycle {s['cycle_count_last_qmax']}, "
          f"design cycle life {s['design_cycle_count']})")
    print(f"Capacity         raw max (FCC) {s['raw_max_capacity_mah']} mAh, design {s['design_capacity_mah']} mAh, "
          f"Qmax per cell {s['qmax_mah']}")
    print(f"Resistance       WeightedRa per cell {wra}")
    print(f"Temperature      now {s['temperature_c']:.1f} C, lifetime avg {s['life_avg_temp_c']} C, "
          f"max {s['life_max_temp_c']} C")
    print("")
    print("Learned model (predicts; does not see the measured capacity)")
    print(f"  inputs         {', '.join(model['models']['soh']['features'])}; {r_note}")
    print(f"  SoH            {pct(mid['learned']['soh_bps'])}   interval {pct(l_low)} to {pct(l_high)} "
          f"(width {(l_high - l_low) / 100:.1f} points)")
    print(f"  grade          {inference.GRADE_NAMES[l_grade]}")
    if ood:
        print(f"  outside training range: {', '.join(ood)}")
    print("")
    if meas is not None:
        print("Measured method (measures: full charge capacity / design capacity)")
        print(f"  measured       {pct(meas['measured_bps'])}, cycles since last Qmax update: {meas['cycles_since_update']:.0f} "
              f"({'fresh' if meas['fresh'] else 'stale'}, limit {params['fresh_cycles']})")
        print(f"  SoH            {pct(meas['soh_bps'])}   interval {pct(meas['soh_low_bps'])} to "
              f"{pct(meas['soh_high_bps'])} (gauge accuracy +/- {params['accuracy'] * 100:.0f} point, "
              f"plus staleness)")
        print(f"  grade          {meas['grade_name']}")
        if qmax_soh is not None:
            print(f"  note           mean Qmax / design is {qmax_soh * 100:.1f}%. Qmax is the low-rate chemical")
            print("                 capacity and reads above design; full charge capacity is the comparable figure.")
        print("")
        print("Consistency check")
        if consistent:
            print("  measured SoH is inside the learned interval: no flag")
        else:
            print("  FLAG: measured SoH is outside the learned interval for this cell state")
        print("")
    print("Submitted by the combined grader")
    print(f"  source         {'measured (fresh Qmax)' if use_measured else 'learned (no fresh Qmax)'}")
    print(f"  interval       {pct(final_low)} to {pct(final_high)}")
    print(f"  grade          {inference.GRADE_NAMES[final_grade]} (on-chain rule: high < 60% recycle, width > 10 "
          f"points bench test, low >= 80% reuse, low >= 60% repurpose)")
    print("")
    print("Remaining useful life (learned RUL models, from the measured SoH)")
    print(f"  to 80% SoH     {rul80[1]} cycles  (interval {rul80[0]} to {rul80[2]})")
    print(f"  to 60% SoH     {rul60[1]} cycles  (interval {rul60[0]} to {rul60[2]})")
    print("")
    print("Caveats")
    print("  The learned model was trained on single lab cells (CALCE LCO, Severson LFP); a 3-cell")
    print("  laptop pack is outside that domain and its interval is wide for that reason.")
    print("  The measured interval rests on TI's stated Impedance Track accuracy and on the gauge being")
    print("  honest. The consistency check is the only cross-check, and with the learned interval this")
    print("  wide it can only catch large inflation.")
    print("  RUL is an extrapolation from lab cells cycled to end of life. Treat it as rough.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

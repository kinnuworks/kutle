"""Pure Python inference for both Kutle SoH methods and the combined grader.

Standard library only. Mirrors model/js/infer.mjs line for line. Both use only
additions, subtractions, multiplications, divisions and comparisons, which
IEEE 754 defines exactly, so the two produce identical numbers for identical
inputs.

infer(model, inputs)
    The learned model (model.json): SoH point and interval in bps from gauge
    signals that do not include the measured capacity, plus remaining useful
    life to 80% and 60% SoH. Missing inputs are None.

measured_infer(params, inputs)
    The measured-capacity method (measured_method.json): SoH = capacity /
    design, widened for gauge accuracy and for how stale the last Qmax update is.

combined(model, params, inputs)
    The deployed grader: grades with the measured-fresh method when the last
    Qmax update is fresh, otherwise submits BENCH_TEST; flags a measured SoH
    above the learned model's upper bound as possible tampering.

Grades follow PassportRegistry.gradeFor.
"""

from __future__ import annotations

import json
import math

GRADE_REUSE = 1
GRADE_REPURPOSE = 2
GRADE_BENCH_TEST = 3
GRADE_RECYCLE = 4
GRADE_NAMES = {1: "REUSE", 2: "REPURPOSE", 3: "BENCH_TEST", 4: "RECYCLE"}

REUSE_FLOOR_BPS = 8000
REPURPOSE_FLOOR_BPS = 6000
MAX_INTERVAL_BPS = 1000
SOH_MAX = 1.2


def grade_for(low_bps: int, high_bps: int) -> int:
    """Same rule as PassportRegistry.gradeFor."""
    if high_bps < REPURPOSE_FLOOR_BPS:
        return GRADE_RECYCLE
    if high_bps - low_bps > MAX_INTERVAL_BPS:
        return GRADE_BENCH_TEST
    if low_bps >= REUSE_FLOOR_BPS:
        return GRADE_REUSE
    if low_bps >= REPURPOSE_FLOOR_BPS:
        return GRADE_REPURPOSE
    return GRADE_BENCH_TEST


def load(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _missing(x) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


def _tree_value(tree: dict, row: list) -> float:
    f, t, m, l, r, v = tree["f"], tree["t"], tree["m"], tree["l"], tree["r"], tree["v"]
    i = 0
    while f[i] != -1:
        x = row[f[i]]
        if x is None:
            i = l[i] if m[i] == 1 else r[i]
        elif x <= t[i]:
            i = l[i]
        else:
            i = r[i]
    return v[i]


def _raw(gbm: dict, row: list) -> float:
    acc = gbm["baseline"]
    for tree in gbm["trees"]:
        acc = acc + _tree_value(tree, row)
    return acc


def _round(x: float) -> int:
    return int(math.floor(x + 0.5))


def _clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def _present_groups(model: dict, inputs: dict) -> list:
    out = []
    for g in model["group_order"]:
        if all(not _missing(inputs.get(name)) for name in model["groups"][g]):
            out.append(g)
    return out


def _half_width(interval: dict, q: float, raw: float) -> float:
    if interval["kind"] == "relative":
        s = 1.0 - raw
        if s < interval["floor"]:
            s = interval["floor"]
        return q * s
    return q


def _part(model: dict, key: str, inputs: dict, present: list) -> dict:
    part = model["models"][key]
    feats = part["features"]
    used = [g for g in model["group_order"] if g in present and any(n in feats for n in model["groups"][g])]
    missing_names = set()
    for g in model["group_order"]:
        if g not in present:
            for n in model["groups"][g]:
                missing_names.add(n)
    row = []
    for name in feats:
        x = inputs.get(name)
        row.append(None if (name in missing_names or _missing(x)) else float(x))
    pattern = "+".join(used) if used else "none"
    ood = []
    for name, x in zip(feats, row):
        if x is None:
            continue
        rng = model["train_range"].get(name)
        if rng is not None and (x < rng[0] or x > rng[1]):
            ood.append(name)
    raw = _raw(part["gbm"], row)
    hw = _half_width(part["interval"], part["interval"]["q"][pattern], raw)
    return {"raw": raw, "hw": hw, "pattern": pattern, "ood": ood}


def infer(model: dict, inputs: dict) -> dict:
    """Learned model: SoH and RUL from gauge signals other than measured capacity."""
    inputs = dict(inputs)
    present = _present_groups(model, inputs)

    s = _part(model, "soh", inputs, present)
    soh = s["raw"]
    lo_bps = _round(_clamp(soh - s["hw"], 0.0, SOH_MAX) * 10000.0)
    hi_bps = _round(_clamp(soh + s["hw"], 0.0, SOH_MAX) * 10000.0)

    soh_source = "measured"
    if _missing(inputs.get("soh_now")):
        inputs["soh_now"] = soh
        soh_source = "model"
    cyc = inputs.get(model["counter"])
    cyc = 1.0 if _missing(cyc) or cyc < 1.0 else float(cyc)
    inputs["fade_life"] = (1.0 - inputs["soh_now"]) * 100.0 / cyc
    present_rul = _present_groups(model, inputs)

    out = {
        "soh": soh,
        "soh_bps": _round(_clamp(soh, 0.0, SOH_MAX) * 10000.0),
        "soh_low_bps": lo_bps,
        "soh_high_bps": hi_bps,
        "soh_pattern": s["pattern"],
        "soh_ood": s["ood"],
        "soh_now_source": soh_source,
        "grade": grade_for(lo_bps, hi_bps),
    }
    for key, threshold in (("rul80", 0.80), ("rul60", 0.60)):
        r = _part(model, key, inputs, present_rul)
        if inputs["soh_now"] < threshold:
            out[key] = 0
            out[key + "_low"] = 0
            out[key + "_high"] = 0
        else:
            root = r["raw"] if r["raw"] > 0.0 else 0.0
            lo_root = r["raw"] - r["hw"]
            lo_root = lo_root if lo_root > 0.0 else 0.0
            hi_root = r["raw"] + r["hw"]
            out[key] = _round(root * root)
            out[key + "_low"] = _round(lo_root * lo_root)
            out[key + "_high"] = _round(hi_root * hi_root)
        out[key + "_raw"] = r["raw"]
        out[key + "_pattern"] = r["pattern"]
        out[key + "_ood"] = r["ood"]
    out["grade_name"] = GRADE_NAMES[out["grade"]]
    return out


def measured_infer(params: dict, inputs: dict) -> dict:
    """Measured method. inputs: soh_measured (capacity / design), cycles_since_update."""
    sm = float(inputs["soh_measured"])
    n = inputs.get("cycles_since_update")
    n = 0.0 if _missing(n) or n < 0.0 else float(n)
    point = sm - n * params["fade_median_per_cycle"]
    low = sm - params["accuracy"] - n * params["fade_p90_per_cycle"]
    high = sm + params["accuracy"]
    lo_bps = _round(_clamp(low, 0.0, SOH_MAX) * 10000.0)
    hi_bps = _round(_clamp(high, 0.0, SOH_MAX) * 10000.0)
    g = grade_for(lo_bps, hi_bps)
    return {
        "soh_bps": _round(_clamp(point, 0.0, SOH_MAX) * 10000.0),
        "soh_low_bps": lo_bps,
        "soh_high_bps": hi_bps,
        "measured_bps": _round(_clamp(sm, 0.0, SOH_MAX) * 10000.0),
        "cycles_since_update": n,
        "fresh": n <= params["fresh_cycles"],
        "grade": g,
        "grade_name": GRADE_NAMES[g],
    }


def combined(model: dict, params: dict, inputs: dict) -> dict:
    """The deployed grader.

    params is the measured-fresh method (measured_fresh_method.json). A fresh
    reading is graded with the measured interval. A stale or missing reading is
    not graded: the submission is the interval [0, 120%], which gradeFor turns
    into BENCH_TEST. The tamper rule flags a measured SoH above the learned
    model's upper bound, and a flagged reading is also submitted as BENCH_TEST.
    The learned model supplies the remaining-life estimate and is shown for
    information.
    """
    learned_inputs = dict(inputs)
    learned_inputs.pop("soh_measured", None)
    learned_inputs.pop("cycles_since_update", None)
    has_measured = not _missing(inputs.get("soh_measured"))
    if has_measured and _missing(learned_inputs.get("soh_now")):
        learned_inputs["soh_now"] = inputs["soh_measured"]
    learned = infer(model, learned_inputs)
    meas = measured_infer(params, inputs) if has_measured else None
    tamper = None if meas is None else meas["measured_bps"] > learned["soh_high_bps"]
    if meas is not None and meas["fresh"] and not tamper:
        source = "measured_fresh"
        soh_bps, low, high = meas["soh_bps"], meas["soh_low_bps"], meas["soh_high_bps"]
    else:
        source = "not_graded"
        soh_bps = meas["soh_bps"] if meas is not None else learned["soh_bps"]
        low, high = 0, _round(SOH_MAX * 10000.0)
    g = grade_for(low, high)
    return {
        "learned": learned,
        "measured": meas,
        "tamper_flag": tamper,
        "source": source,
        "submission": {
            "modelId": params["model_id"],
            "sohBps": soh_bps,
            "lowBps": low,
            "highBps": high,
            "rulCycles": learned["rul80"],
            "grade": g,
            "grade_name": GRADE_NAMES[g],
        },
    }

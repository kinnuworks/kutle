"""Python and JavaScript inference must agree exactly on the exported files."""

import csv
import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from kutle_health import inference

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "artifacts" / "model.json"
MEASURED = ROOT / "artifacts" / "measured_fresh_method.json"
EVAL = ROOT / "artifacts" / "eval_set.csv"
JS = ROOT / "js" / "infer.mjs"


def samples(model, n=50):
    rng = random.Random(7)
    feats = set(model["models"]["rul80"]["features"]) | {"cycle", "efc"}
    rows = list(csv.DictReader(open(EVAL)))
    rng.shuffle(rows)
    out = []
    for r in rows[: n - 10]:
        x = {k: (None if r.get(k) in (None, "", "nan") else float(r[k])) for k in feats if k != "fade_life"}
        for g in model["group_order"]:
            if rng.random() < 0.3:
                for k in model["groups"][g]:
                    x[k] = None
        if rng.random() < 0.2:
            x["soh_now"] = None
        if rng.random() < 0.7:
            x["soh_measured"] = float(r["y_soh"]) + rng.uniform(-0.02, 0.2)
            x["cycles_since_update"] = rng.choice([0, 3, 49, 50, 51, 120, None])
        out.append(x)
    out += [
        {"cycle": 170, "efc": 170, "r_ratio": 1.2, "t_mean": 26.7, "t_max": 41, "dv_mean_dis": None,
         "chg_c_max": 1.152, "dis_c_max": 0.832, "fade_recent": None, "soh_measured": 0.9485,
         "cycles_since_update": 1},
        {"cycle": 1, "efc": 1, "r_ratio": 1.0, "soh_now": 1.0},
        {"cycle": 5000, "efc": 4000, "r_ratio": 3.0, "t_mean": 60, "t_max": 80, "dv_mean_dis": -500,
         "chg_c_max": 10, "dis_c_max": 10, "soh_now": 0.5, "fade_recent": 2.0, "soh_measured": 0.5,
         "cycles_since_update": 0},
        {"cycle": 0, "soh_now": 0.79},
        {"cycle": 300, "efc": 280, "soh_measured": 0.61, "r_ratio": 1.4, "cycles_since_update": 10},
        {"cycle": 300, "soh_now": 0.59},
        {},
        {"cycle": 800, "efc": 700, "r_ratio": 1.1, "soh_now": 0.85, "fade_recent": 0.5, "soh_measured": 1.3,
         "cycles_since_update": -4},
        {"cycle": 120, "efc": 118, "r_ratio": 0.9, "soh_measured": 0.95, "cycles_since_update": 2.5},
        {"cycle": 450.5, "efc": 430.25, "r_ratio": 1.25, "soh_measured": 0.8},
    ]
    return out[:n]


@pytest.mark.skipif(not MODEL.exists() or not MEASURED.exists(), reason="run training first")
@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_python_and_js_agree_on_50_samples():
    model = inference.load(str(MODEL))
    params = inference.load(str(MEASURED))
    xs = samples(model, 50)
    assert len(xs) == 50
    py = [inference.combined(model, params, x) for x in xs]
    proc = subprocess.run(["node", str(JS), str(MODEL), str(MEASURED)], input=json.dumps(xs),
                          capture_output=True, text=True, check=True)
    js = json.loads(proc.stdout)
    assert len(js) == 50
    assert json.loads(json.dumps(py)) == js
    assert any(r["measured"] is not None for r in py) and any(r["measured"] is None for r in py)
    assert {r["source"] for r in py} == {"measured_fresh", "not_graded"}
    assert any(r["tamper_flag"] for r in py)


def test_grade_rule_matches_contract():
    g = inference.grade_for
    assert g(5000, 5999) == inference.GRADE_RECYCLE
    assert g(7000, 8100) == inference.GRADE_BENCH_TEST  # width 1100 > 1000
    assert g(8000, 9000) == inference.GRADE_REUSE
    assert g(7999, 8999) == inference.GRADE_REPURPOSE
    assert g(6000, 7000) == inference.GRADE_REPURPOSE
    assert g(5900, 6100) == inference.GRADE_BENCH_TEST


def test_measured_method_widens_with_staleness():
    p = {"accuracy": 0.01, "fade_median_per_cycle": 0.0003, "fade_p90_per_cycle": 0.001, "fresh_cycles": 50}
    fresh = inference.measured_infer(p, {"soh_measured": 0.9, "cycles_since_update": 0})
    stale = inference.measured_infer(p, {"soh_measured": 0.9, "cycles_since_update": 40})
    assert (fresh["soh_low_bps"], fresh["soh_high_bps"]) == (8900, 9100)
    assert stale["soh_low_bps"] == 8500 and stale["soh_high_bps"] == 9100
    assert fresh["fresh"] and stale["fresh"]
    assert not inference.measured_infer(p, {"soh_measured": 0.9, "cycles_since_update": 51})["fresh"]


def _toy_model():
    """A learned model with one tree that predicts 0.9 with a +/- 0.05 interval."""
    tree = {"f": [-1], "t": [0.0], "m": [0], "l": [-1], "r": [-1], "v": [0.0]}
    part = lambda base: {"features": ["cycle"], "gbm": {"baseline": base, "trees": [tree]},  # noqa: E731
                         "interval": {"kind": "absolute", "floor": 0.05, "q": {"none": 0.05}}}
    return {"counter": "cycle", "group_order": [], "groups": {}, "train_range": {},
            "models": {"soh": part(0.9), "rul80": part(10.0), "rul60": part(20.0)}}


def test_freshness_rule_and_tamper_rule():
    model = _toy_model()
    params = {"model_id": "kutle-soh-measured-fresh-v1", "accuracy": 0.01, "fade_median_per_cycle": 0.0003,
              "fade_p90_per_cycle": 0.001, "fresh_cycles": 5}
    fresh = inference.combined(model, params, {"cycle": 100, "soh_measured": 0.9, "cycles_since_update": 5})
    assert fresh["source"] == "measured_fresh" and fresh["submission"]["grade_name"] == "REUSE"
    assert fresh["submission"]["rulCycles"] == 100
    stale = inference.combined(model, params, {"cycle": 100, "soh_measured": 0.9, "cycles_since_update": 6})
    assert stale["source"] == "not_graded"
    assert (stale["submission"]["lowBps"], stale["submission"]["highBps"]) == (0, 12000)
    assert stale["submission"]["grade_name"] == "BENCH_TEST"
    none = inference.combined(model, params, {"cycle": 100})
    assert none["source"] == "not_graded" and none["submission"]["grade_name"] == "BENCH_TEST"
    # measured 97% is above the learned upper bound of 95%: flagged, not graded
    tampered = inference.combined(model, params, {"cycle": 100, "soh_measured": 0.97, "cycles_since_update": 0})
    assert tampered["tamper_flag"] and tampered["submission"]["grade_name"] == "BENCH_TEST"
    low = inference.combined(model, params, {"cycle": 100, "soh_measured": 0.82, "cycles_since_update": 0})
    assert low["tamper_flag"] is False and low["source"] == "measured_fresh"

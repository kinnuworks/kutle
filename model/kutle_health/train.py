"""Train, evaluate and export the Kutle battery health methods.

Two methods, registered under separate model ids:

  kutle-soh-learned-v2   predicts SoH from gauge signals other than the
                         measured capacity (cycle counter, resistance growth,
                         ...), with an interval calibrated across datasets.
  kutle-soh-measured-v1  measures SoH as capacity / design, with an interval
                         from the gauge's stated accuracy plus staleness.

Protocol, fixed before any held-out number was looked at:

  * Held-out dataset: NASA PCoE. The registered evaluation set is the NASA
    cells run at 24 C ambient whose first clean capacity reading is at least
    80% of rating (B0005, B0006, B0007, B0018, B0034, B0036). The cells run at
    4 C, 43 C and 44 C, and the ones that start far below rating, are
    dominated by capacity swings from temperature and test protocol, which
    are not ageing; they are reported separately as a stress set. NASA is
    never used for fitting, feature selection, transfer choices,
    hyperparameters or calibration.
  * Training datasets: CALCE (LCO) and Severson et al. (LFP). Each dataset,
    and each cell inside a dataset, carries equal weight.
  * Hyperparameters are fixed in HGB_PARAMS. Choices made from data, all on the
    training datasets only:
      - feature set, cycle counter (raw cycles or equivalent full cycles) and
        whether to impose monotone constraints, by leave-one-dataset-out
        (LODO) MAE between the training datasets;
      - interval score (absolute or relative), by the swap test in
        calibration.py.
  * Learned-model intervals: split conformal on pooled LODO residuals (fit on
    one training dataset, residuals on the other), one quantile per pattern of
    optional inputs present, target coverage 90%.
  * Measured method: gauge accuracy from TI's published Impedance Track figure
    and staleness widening from training-data fade rates. On NASA it is
    evaluated on simulated gauge readings (noise plus a stale Qmax).
  * Baseline: linear SoH versus cycle count fitted on the training cells, both
    with the model's weights and unweighted; the registry gets the lower error.

Run:  .venv/bin/python -m kutle_health.train
"""

from __future__ import annotations

import hashlib
import itertools
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import GroupKFold

from . import calibration, inference, measured
from .conformal import conformal_quantile, coverage, weighted_quantile
from .consistency import tamper_eval
from .features import GROUPS, RUL_EXTRA, build_table
from .gbm import export_hgb, predict_raw
from .loaders import LOADERS

ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = Path(os.environ.get("KUTLE_ARTIFACTS", ROOT / "artifacts"))

HELDOUT = os.environ.get("KUTLE_HELDOUT", "nasa")
TRAIN = os.environ.get("KUTLE_TRAIN", "calce,severson").split(",")
ALPHA = 0.10
SEED = 20230712  # Regulation (EU) 2023/1542 publication date, used as a fixed seed
N_FOLDS = 5
GROUP_ORDER = ["res", "temp", "volt", "hist"]
LEARNED_ID = "kutle-soh-learned-v2"
MEASURED_ID = "kutle-soh-measured-v1"
MEASURED_FRESH_ID = "kutle-soh-measured-fresh-v1"
FRESH_MAX_SEARCH = 300
CARD_URI = "model/artifacts/MODEL_CARD.md"
DISCLOSURE = (
    "kutle-soh-measured-fresh-v1 and its freshness rule were adopted after the first NASA evaluation of "
    "kutle-soh-measured-v1 showed that the training-data staleness allowance under-covers fast-fading cells. "
    "The freshness limit itself was set from training data only, but the decision to add a freshness rule was "
    "made after seeing NASA results, so its NASA numbers are not a clean held-out test."
)
MIN_COVERAGE_BPS = 8500  # ModelRegistry.MIN_COVERAGE_BPS

HGB_PARAMS = dict(
    loss="absolute_error",
    max_iter=200,
    learning_rate=0.05,
    max_leaf_nodes=15,
    min_samples_leaf=50,
    l2_regularization=1.0,
    early_stopping=False,
    random_state=0,
)

# "COUNTER" is replaced by "cycle" or "efc".
SOH_CANDIDATES = {
    "minimal": ["COUNTER", "r_ratio"],
    "gauge": ["COUNTER", "r_ratio", "t_mean", "t_max", "dv_mean_dis"],
    "gauge_rates": ["COUNTER", "r_ratio", "t_mean", "t_max", "dv_mean_dis", "chg_c_max", "dis_c_max"],
}
COUNTER_CHOICES = ["cycle", "efc"]
MONOTONE_CHOICES = [False, True]
# Direction of the monotone constraint on SoH, where one is physically expected.
MONOTONE_DIRECTION = {"cycle": -1, "efc": -1, "r_ratio": -1, "dv_mean_dis": 1}

THRESHOLDS = {"rul80": 0.80, "rul60": 0.60}

# Simulated gauge readings for the measured method on NASA.
GAUGE_NOISE_PRIMARY = 0.005  # 1-sigma; TI's "better than 1%" read as a ~2-sigma bound
GAUGE_NOISE_STRESS = 0.010  # TI's figure read as 1 sigma
MAX_STALENESS = 30  # cycles since the last Qmax update, drawn uniformly from 0..30
TAMPER_POINTS = [0.05, 0.10, 0.20]


# ------------------------------------------------------------------ helpers


def log(msg: str) -> None:
    print(msg, flush=True)


def in_registered_eval(df: pd.DataFrame) -> np.ndarray:
    """Registered held-out rows: room temperature cells that start near rating."""
    if HELDOUT != "nasa":
        return np.ones(len(df), dtype=bool)
    return ((df["ambient_c"].round() == 24) & (df["first_soh"] >= 0.80)).to_numpy()


def dataset_weights(df: pd.DataFrame) -> np.ndarray:
    """Each dataset sums to 1, split evenly across its cells, then across rows."""
    w = np.zeros(len(df))
    for ds, dsub in df.groupby("dataset"):
        cells = dsub["cell"].unique()
        for c in cells:
            m = ((df["dataset"] == ds) & (df["cell"] == c)).to_numpy()
            w[m] = 1.0 / len(cells) / m.sum()
    return w / w.sum() * df["dataset"].nunique()


def groups_in(feats: list[str]) -> list[str]:
    return [g for g in GROUP_ORDER if any(n in feats for n in GROUPS[g])]


def patterns(feats: list[str]) -> list[tuple[str, ...]]:
    gs = groups_in(feats)
    out = []
    for k in range(len(gs) + 1):
        for combo in itertools.combinations(gs, k):
            out.append(tuple(g for g in GROUP_ORDER if g in combo))
    return out


def pattern_key(p: tuple[str, ...]) -> str:
    return "+".join(p) if p else "none"


def apply_pattern(X: pd.DataFrame, feats: list[str], present: tuple[str, ...]) -> np.ndarray:
    X = X[feats].copy()
    for g in groups_in(feats):
        if g not in present:
            for n in GROUPS[g]:
                if n in X:
                    X[n] = np.nan
    return X.to_numpy(dtype=float)


def rows_with(X: pd.DataFrame, present: tuple[str, ...]) -> np.ndarray:
    """Rows where every group in `present` is actually available."""
    ok = np.ones(len(X), dtype=bool)
    for g in present:
        for n in GROUPS[g]:
            if n in X:
                ok &= X[n].notna().to_numpy()
    return ok


def augment(X: pd.DataFrame, y: np.ndarray, w: np.ndarray, feats: list[str], rng) -> tuple:
    """Original rows plus one copy with each optional group dropped with p = 0.5.

    This teaches the trees what to do when a group is missing in the field.
    """
    Xa = X[feats].copy()
    for g in groups_in(feats):
        drop = rng.random(len(Xa)) < 0.5
        for n in GROUPS[g]:
            if n in Xa:
                Xa.loc[drop, n] = np.nan
    Xall = np.vstack([X[feats].to_numpy(dtype=float), Xa.to_numpy(dtype=float)])
    return Xall, np.concatenate([y, y]), np.concatenate([w, w]) * 0.5


def fit(X: pd.DataFrame, y: np.ndarray, w: np.ndarray, feats: list[str], seed: int, monotone: bool = False):
    rng = np.random.default_rng(seed)
    Xa, ya, wa = augment(X, y, w, feats, rng)
    # scikit-learn cannot bin a column that is entirely missing. A constant
    # column is never split on, so filling it changes nothing at prediction time.
    empty = np.all(np.isnan(Xa), axis=0)
    Xa[:, empty] = 0.0
    params = dict(HGB_PARAMS)
    if monotone:
        params["monotonic_cst"] = [MONOTONE_DIRECTION.get(n, 0) for n in feats]
    m = HistGradientBoostingRegressor(**params)
    m.fit(Xa, ya, sample_weight=wa)
    return m


def wmae(err: np.ndarray, w: np.ndarray) -> float:
    ok = np.isfinite(err)
    return float(np.sum(np.abs(err[ok]) * w[ok]) / np.sum(w[ok])) if ok.any() else float("nan")


def oof_predictions(df, feats, target, w, splits, monotone=False) -> dict:
    """Out-of-fold predictions for every pattern of optional groups."""
    pats = patterns(feats)
    pred = {p: np.full(len(df), np.nan) for p in pats}
    for k, (tr, te) in enumerate(splits):
        m = fit(df.iloc[tr], target[tr], w[tr], feats, SEED + k, monotone)
        for p in pats:
            pred[p][te] = m.predict(apply_pattern(df.iloc[te], feats, p))
    return pred


def grouped_splits(df: pd.DataFrame):
    cells = df["cell"].to_numpy()
    n = min(N_FOLDS, len(np.unique(cells)))
    return list(GroupKFold(n_splits=n).split(df, groups=cells))


def lodo_splits(df: pd.DataFrame):
    out = []
    ds = df["dataset"].to_numpy()
    for d in sorted(set(ds)):
        te = np.nonzero(ds == d)[0]
        tr = np.nonzero(ds != d)[0]
        if len(tr) and len(te):
            out.append((tr, te))
    return out


def row_pattern_keys(df: pd.DataFrame, feats: list[str]) -> np.ndarray:
    gs = groups_in(feats)
    has = {g: rows_with(df, (g,)) for g in gs}
    return np.array([pattern_key(tuple(g for g in gs if has[g][i])) for i in range(len(df))])


def q_table(df, feats, target, pred, w, kind) -> dict:
    """Interval quantile per pattern, calibrated on rows that really have those groups."""
    out = {}
    for p in patterns(feats):
        ok = rows_with(df, p) & np.isfinite(pred[p])
        if ok.sum() >= 30:
            out[pattern_key(p)] = calibration.quantile(target[ok], pred[p][ok], kind, ALPHA, w[ok])
    widest = max(out.values()) if out else float("nan")
    for p in patterns(feats):
        out.setdefault(pattern_key(p), widest)
    return out


def fit_linear_baseline(cycle: np.ndarray, soh: np.ndarray, w: np.ndarray | None) -> tuple[float, float]:
    A = np.vstack([np.ones_like(cycle), cycle]).T
    if w is None:
        w = np.ones_like(cycle)
    sw = np.sqrt(w)
    coef, *_ = np.linalg.lstsq(A * sw[:, None], soh * sw, rcond=None)
    return float(coef[0]), float(coef[1])


def baseline_errors(tr_df, w_tr, te_df) -> tuple[np.ndarray, np.ndarray, dict]:
    aw, bw = fit_linear_baseline(tr_df["cycle"].to_numpy(), tr_df["y_soh"].to_numpy(), w_tr)
    au, bu = fit_linear_baseline(tr_df["cycle"].to_numpy(), tr_df["y_soh"].to_numpy(), None)
    c, y = te_df["cycle"].to_numpy(), te_df["y_soh"].to_numpy()
    ew, eu = aw + bw * c - y, au + bu * c - y
    info = {"weighted": {"intercept": aw, "slope_per_cycle": bw}, "unweighted": {"intercept": au, "slope_per_cycle": bu}}
    return ew, eu, info


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_commit() -> str | None:
    try:
        return subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return None


def bps(x: float):
    return None if not np.isfinite(x) else int(round(x * 10000))


def resolve(feats: list[str], counter: str) -> list[str]:
    return [counter if f == "COUNTER" else f for f in feats]


def with_counter(df: pd.DataFrame, counter: str) -> pd.DataFrame:
    """fade_life is measured per unit of the chosen counter."""
    df = df.copy()
    df["fade_life"] = df["fade_life_efc"] if counter == "efc" else df["fade_life"]
    return df


def freshness_limit(train_df: pd.DataFrame, w: np.ndarray, tol: float = 0.01) -> tuple[int, dict]:
    """Largest staleness N (cycles) at which 90% of training fade over N cycles stays within tol.

    Uses the centered 5-cycle median of SoH so that single-cycle measurement
    noise does not count as fade. Each dataset weighs equally.
    """
    from .features import centered_median

    smooth = np.empty(len(train_df))
    for _, idx in train_df.groupby("cell").groups.items():
        idx = np.asarray(idx)
        smooth[idx] = centered_median(train_df["y_soh"].to_numpy()[idx], 5)
    cells = [np.asarray(idx) for _, idx in train_df.groupby("cell").groups.items()]
    table = {}
    best = 0
    for n in range(1, FRESH_MAX_SEARCH + 1):
        fades, weights = [], []
        for idx in cells:
            cyc = train_df["cycle"].to_numpy()[idx]
            j = np.searchsorted(cyc, cyc - n, side="left")
            ok = (cyc - cyc[0]) >= n
            if ok.any():
                fades.append(smooth[idx][j[ok]] - smooth[idx][ok])
                weights.append(w[idx][ok])
        if not fades:
            break
        p90 = weighted_quantile(np.concatenate(fades), 0.9, np.concatenate(weights))
        if n in (1, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100) or p90 <= tol:
            table[n] = round(p90 * 100, 3)
        if p90 <= tol:
            best = n
        else:
            break
    return best, table


def fit_and_calibrate(tr_df: pd.DataFrame, feats: list[str], monotone: bool, kind: str | None = None) -> dict:
    """Final SoH model on tr_df plus LODO-calibrated interval table."""
    w = dataset_weights(tr_df)
    y = tr_df["y_soh"].to_numpy()
    p_lo = oof_predictions(tr_df, feats, y, w, lodo_splits(tr_df), monotone)
    full = tuple(groups_in(feats))
    swap = None
    if kind is None:
        ok = rows_with(tr_df, full)
        kind, swap = calibration.choose_kind(y[ok], p_lo[full][ok], tr_df["dataset"].to_numpy()[ok], w[ok], ALPHA)
    q = q_table(tr_df, feats, y, p_lo, w, kind)
    model = fit(tr_df, y, w, feats, SEED, monotone)
    return {"model": model, "kind": kind, "q": q, "swap": swap, "p_lo": p_lo}


# ------------------------------------------------------------------ main


def main() -> int:
    t0 = time.time()
    ARTIFACTS.mkdir(exist_ok=True)
    records = {}
    for name in [HELDOUT] + TRAIN:
        records[name] = LOADERS[name]()
        log(f"{name}: {len(records[name])} cells after cleaning")
    if any(not records[n] for n in [HELDOUT] + TRAIN):
        log("cannot run the fixed protocol, a dataset is missing")
        return 1

    all_df = build_table([r for n in [HELDOUT] + TRAIN for r in records[n]])
    train_df = all_df[all_df["dataset"].isin(TRAIN)].reset_index(drop=True)
    heldout_all = all_df[all_df["dataset"] == HELDOUT].reset_index(drop=True)
    reg = in_registered_eval(heldout_all)
    test_df = heldout_all[reg].reset_index(drop=True)
    stress_df = heldout_all[~reg].reset_index(drop=True)
    w_train = dataset_weights(train_df)
    y_train = train_df["y_soh"].to_numpy()
    log(f"train rows {len(train_df)} ({train_df['cell'].nunique()} cells), registered held-out rows "
        f"{len(test_df)} {sorted(test_df['cell'].unique())}")

    cv = grouped_splits(train_df)
    lodo = lodo_splits(train_df)

    # ----------------------------------- feature set and transfer choices (LODO)
    selection = {}
    for (fs, feats0), counter, mono in itertools.product(SOH_CANDIDATES.items(), COUNTER_CHOICES, MONOTONE_CHOICES):
        feats = resolve(feats0, counter)
        name = f"{fs}|{counter}|{'monotone' if mono else 'free'}"
        full = tuple(groups_in(feats))
        p_lo = oof_predictions(train_df, feats, y_train, w_train, lodo, mono)
        p_cv = oof_predictions(train_df, feats, y_train, w_train, cv, mono)
        per_ds = {d: bps(wmae((y_train - p_lo[full])[train_df["dataset"] == d], w_train[train_df["dataset"] == d]))
                  for d in TRAIN}
        selection[name] = {
            "features": feats, "counter": counter, "monotone": mono,
            "lodo_mae_bps": bps(wmae(y_train - p_lo[full], w_train)),
            "lodo_mae_bps_by_left_out_dataset": per_ds,
            "grouped_cv_mae_bps": bps(wmae(y_train - p_cv[full], w_train)),
        }
        log(f"  {name}: LODO {selection[name]['lodo_mae_bps']} bps {per_ds}, grouped CV "
            f"{selection[name]['grouped_cv_mae_bps']} bps")
    chosen = min(selection, key=lambda k: selection[k]["lodo_mae_bps"])
    soh_feats = selection[chosen]["features"]
    counter = selection[chosen]["counter"]
    mono = selection[chosen]["monotone"]
    log(f"chosen: {chosen}")

    train_df = with_counter(train_df, counter)
    test_df = with_counter(test_df, counter)
    stress_df = with_counter(stress_df, counter)

    fc = fit_and_calibrate(train_df, soh_feats, mono)
    soh_model, kind, q_soh = fc["model"], fc["kind"], fc["q"]
    log(f"interval score chosen by swap test: {kind}; swap test {json.dumps(fc['swap'])}")
    log(f"q table: {q_soh}")

    # ---------------------------------------------------------- RUL models
    rul_feats = soh_feats + RUL_EXTRA
    rul_models, rul_q, rul_info = {}, {}, {}
    for key in THRESHOLDS:
        ok = train_df[f"y_{key}"].notna().to_numpy()
        sub = train_df[ok].reset_index(drop=True)
        target = np.sqrt(sub[f"y_{key}"].to_numpy())
        w = dataset_weights(sub)
        splits = lodo_splits(sub)
        info = {"rows": int(ok.sum()), "cells": int(sub["cell"].nunique()),
                "cells_by_dataset": {k: int(v) for k, v in sub.groupby("dataset")["cell"].nunique().items()},
                "interval_score": "absolute, on sqrt(cycles)"}
        if len(splits) >= 2:
            info["calibration"] = "leave-one-dataset-out residuals"
        else:
            splits = grouped_splits(sub)
            info["calibration"] = ("grouped-by-cell CV residuals; only one training dataset reaches this threshold, "
                                   "so there is no out-of-domain calibration and the interval is in-distribution")
        pk = oof_predictions(sub, rul_feats, target, w, splits)
        rul_q[key] = q_table(sub, rul_feats, target, pk, w, "absolute")
        rul_models[key] = fit(sub, target, w, rul_feats, SEED)
        rul_info[key] = info
        log(f"  {key}: {info}")

    # --------------------------------------------------------------- export
    train_range = {}
    for n in rul_feats:
        v = train_df[n].to_numpy(dtype=float)
        v = v[np.isfinite(v)]
        if v.size:
            train_range[n] = [float(np.quantile(v, 0.005)), float(np.quantile(v, 0.995))]
    model_json = {
        "format": "kutle-health-gbm-v2",
        "model_id": LEARNED_ID,
        "description": "Learned SoH (does not see measured capacity) with LODO-calibrated interval; RUL to 80% and 60%.",
        "soh_units": "fraction of rated (design) capacity; outputs in bps",
        "rul_units": "cycles; models predict sqrt(cycles)",
        "counter": counter,
        "alpha": ALPHA,
        "group_order": GROUP_ORDER,
        "groups": GROUPS,
        "train_range": train_range,
        "train_datasets": TRAIN,
        "heldout_dataset": HELDOUT,
        "models": {
            "soh": {"features": soh_feats, "target": "soh_fraction", "monotone": mono,
                    "interval": {"kind": kind, "floor": calibration.RELATIVE_FLOOR, "q": q_soh,
                                 "calibration": "pooled leave-one-dataset-out residuals"},
                    "gbm": export_hgb(soh_model)},
            **{k: {"features": rul_feats, "target": "sqrt_cycles",
                   "interval": {"kind": "absolute", "floor": calibration.RELATIVE_FLOOR, "q": rul_q[k],
                                "calibration": rul_info[k]["calibration"]},
                   "gbm": export_hgb(rul_models[k])} for k in THRESHOLDS},
        },
    }
    weights_path = ARTIFACTS / "model.json"
    weights_path.write_text(json.dumps(model_json, separators=(",", ":")) + "\n")

    fade = train_df["fade_recent"].to_numpy() / 100.0
    okf = np.isfinite(fade)
    mparams = measured.params(
        fade_median_per_cycle=weighted_quantile(fade[okf], 0.5, w_train[okf]),
        fade_p90_per_cycle=weighted_quantile(fade[okf], 0.9, w_train[okf]),
    )
    mparams["model_id"] = MEASURED_ID
    measured_path = ARTIFACTS / "measured_method.json"
    measured_path.write_text(json.dumps(mparams, indent=2) + "\n")

    fresh_n, fresh_table = freshness_limit(train_df, w_train)
    fparams = dict(mparams)
    fparams.update({
        "model_id": MEASURED_FRESH_ID,
        "description": "SoH = measured capacity / design capacity, graded only when the last Qmax update is at most "
                       "fresh_cycles old; staler readings are not graded (BENCH_TEST).",
        "fresh_cycles": fresh_n,
        "freshness_source": "TI documents when a Qmax update can happen (two rested OCV readings, at least 37% passed "
                            "charge; SLYT402, SLUA364) but gives no cycle age after which it is invalid. The limit is "
                            "the largest staleness at which the 90th percentile of training-cell fade (centered "
                            "5-cycle median SoH, datasets weighted equally) stays within 1 point.",
        "freshness_p90_fade_points_by_staleness": fresh_table,
    })
    fresh_path = ARTIFACTS / "measured_fresh_method.json"
    fresh_path.write_text(json.dumps(fparams, indent=2) + "\n")
    log(f"freshness limit {fresh_n} cycles; p90 fade by staleness {fresh_table}")
    log(f"measured method params: {mparams}")

    probe = apply_pattern(test_df.head(200), soh_feats, tuple(groups_in(soh_feats)))
    sk = soh_model.predict(probe)
    mine = [predict_raw(model_json["models"]["soh"]["gbm"], [None if np.isnan(x) else float(x) for x in r]) for r in probe]
    max_diff = float(np.max(np.abs(sk - np.array(mine))))
    log(f"export check: max |sklearn - json| = {max_diff}")

    # ---------------------------------------------- held-out: learned model
    eval_cols = (["dataset", "cell", "cycle", "efc"] + [c for c in rul_feats if c not in ("cycle", "efc")]
                 + ["y_soh", "y_rul80", "y_rul60"])
    eval_path = ARTIFACTS / "eval_set.csv"
    test_df[eval_cols].to_csv(eval_path, index=False, float_format="%.10g")
    ev = pd.read_csv(eval_path)

    def run_infer(df: pd.DataFrame, drop: tuple[str, ...] = ()) -> list[dict]:
        outs = []
        for _, row in df.iterrows():
            inp = {n: (None if pd.isna(row[n]) else float(row[n])) for n in rul_feats}
            for g in drop:
                for n in GROUPS[g]:
                    inp[n] = None
            inp.pop("fade_life", None)
            outs.append(inference.infer(model_json, inp))
        return outs

    outs = run_infer(ev)
    y = ev["y_soh"].to_numpy()
    pred = np.array([o["soh"] for o in outs])
    lo = np.array([o["soh_low_bps"] for o in outs]) / 1e4
    hi = np.array([o["soh_high_bps"] for o in outs]) / 1e4
    err = pred - y
    mae_bps = float(np.mean(np.abs(err)) * 1e4)
    cov = coverage(y, lo, hi)
    base_w, base_u, base_info = baseline_errors(train_df, w_train, ev)
    base_w_mae, base_u_mae = float(np.mean(np.abs(base_w)) * 1e4), float(np.mean(np.abs(base_u)) * 1e4)
    baseline_mae = min(base_w_mae, base_u_mae)
    # Extra: the same linear baseline against equivalent full cycles.
    ae, be = fit_linear_baseline(train_df["efc"].to_numpy(), y_train, w_train)
    base_efc_mae = float(np.mean(np.abs(ae + be * ev["efc"].to_numpy() - y)) * 1e4)

    per_cell = []
    for c, idx in ev.groupby("cell").groups.items():
        idx = np.asarray(idx)
        per_cell.append({"cell": c, "rows": int(len(idx)),
                         "mae_bps": round(float(np.mean(np.abs(err[idx])) * 1e4), 1),
                         "baseline_mae_bps": round(float(min(np.mean(np.abs(base_w[idx])), np.mean(np.abs(base_u[idx]))) * 1e4), 1),
                         "coverage": round(coverage(y[idx], lo[idx], hi[idx]), 3),
                         "mean_width_bps": round(float(np.mean(hi[idx] - lo[idx]) * 1e4), 1)})
    by_pattern = {}
    for p in patterns(soh_feats):
        drop = tuple(g for g in groups_in(soh_feats) if g not in p)
        o2 = run_infer(ev, drop)
        pr = np.array([o["soh"] for o in o2])
        l2 = np.array([o["soh_low_bps"] for o in o2]) / 1e4
        h2 = np.array([o["soh_high_bps"] for o in o2]) / 1e4
        by_pattern[pattern_key(p)] = {"mae_bps": round(float(np.mean(np.abs(pr - y)) * 1e4), 1),
                                      "coverage": round(coverage(y, l2, h2), 3),
                                      "mean_width_bps": round(float(np.mean(h2 - l2) * 1e4), 1)}
    grades = np.array([o["grade"] for o in outs])
    grade_counts = {inference.GRADE_NAMES[g]: int(np.sum(grades == g)) for g in (1, 2, 3, 4)}
    permissive = int(np.sum(((grades == 1) & (y < 0.8)) | ((grades == 2) & (y < 0.6))))

    rul_eval = {}
    for key, thr in THRESHOLDS.items():
        yk = ev[f"y_{key}"].to_numpy()
        ok = np.isfinite(yk)
        if not ok.any():
            rul_eval[key] = {"rows": 0, "note": "no held-out cell reaches this threshold"}
            continue
        pk = np.array([o[key] for o in outs])[ok]
        lk = np.array([o[key + "_low"] for o in outs])[ok]
        hk = np.array([o[key + "_high"] for o in outs])[ok]
        soh_now = ev["soh_now"].to_numpy()[ok]
        f_life = (1.0 - soh_now) * 100.0 / np.maximum(ev["cycle"].to_numpy()[ok], 1.0)
        with np.errstate(divide="ignore", invalid="ignore"):
            base = np.where(f_life > 1e-6, (soh_now - thr) / (f_life / 100.0), np.nan)
        base = np.clip(np.nan_to_num(base, nan=5000.0), 0, 5000)
        rul_eval[key] = {
            "rows": int(ok.sum()), "cells": int(ev.loc[ok, "cell"].nunique()),
            "mae_cycles": round(float(np.mean(np.abs(pk - yk[ok]))), 1),
            "median_abs_error_cycles": round(float(np.median(np.abs(pk - yk[ok]))), 1),
            "coverage": round(coverage(yk[ok], lk, hk), 3),
            "mean_width_cycles": round(float(np.mean(hk - lk)), 1),
            "mean_true_rul_cycles": round(float(np.mean(yk[ok])), 1),
            "baseline_mae_cycles": round(float(np.mean(np.abs(base - yk[ok]))), 1),
            "baseline": "(soh_now - threshold) / average fade per cycle since new, capped at 5000",
            "calibration": rul_info[key]["calibration"],
        }

    stress = None
    if len(stress_df):
        so = run_infer(stress_df)
        ys = stress_df["y_soh"].to_numpy()
        ps = np.array([o["soh"] for o in so])
        sw_, su_, _ = baseline_errors(train_df, w_train, stress_df)
        stress = {"cells": sorted(stress_df["cell"].unique().tolist()), "rows": int(len(stress_df)),
                  "mae_bps": round(float(np.mean(np.abs(ps - ys)) * 1e4), 1),
                  "baseline_mae_bps": round(float(min(np.mean(np.abs(sw_)), np.mean(np.abs(su_))) * 1e4), 1),
                  "coverage": round(coverage(ys, np.array([o["soh_low_bps"] for o in so]) / 1e4,
                                             np.array([o["soh_high_bps"] for o in so]) / 1e4), 3),
                  "note": "NASA cells at 4, 43 or 44 C ambient or starting below 80% of rating; not registered"}
        log(f"  stress set: {stress}")

    # ------------------------------- every dataset held out, same procedure
    lodo_all = {}
    for out_ds in [HELDOUT] + TRAIN:
        tr = with_counter(all_df[all_df["dataset"] != out_ds].reset_index(drop=True), counter)
        te = test_df if out_ds == HELDOUT else with_counter(all_df[all_df["dataset"] == out_ds].reset_index(drop=True), counter)
        f2 = fit_and_calibrate(tr, soh_feats, mono)
        pats = row_pattern_keys(te, soh_feats)
        pr = np.empty(len(te))
        for key in set(pats):
            m_ = pats == key
            present = tuple() if key == "none" else tuple(key.split("+"))
            pr[m_] = f2["model"].predict(apply_pattern(te[m_], soh_feats, present))
        hw = np.array([f2["q"][k] for k in pats]) * calibration.scale(pr, f2["kind"])
        yt = te["y_soh"].to_numpy()
        bw_, bu_, _ = baseline_errors(tr, dataset_weights(tr), te)
        bmae = min(np.mean(np.abs(bw_)), np.mean(np.abs(bu_)))
        lodo_all[out_ds] = {"train": sorted(tr["dataset"].unique().tolist()), "interval_score": f2["kind"],
                            "mae_bps": round(float(np.mean(np.abs(pr - yt)) * 1e4), 1),
                            "baseline_mae_bps": round(float(bmae * 1e4), 1),
                            "coverage": round(float(np.mean(np.abs(yt - pr) <= hw)), 3),
                            "mean_width_bps": round(float(np.mean(2 * hw) * 1e4), 1),
                            "beats_baseline": bool(np.mean(np.abs(pr - yt)) < bmae)}
        log(f"  {out_ds} held out: {lodo_all[out_ds]}")

    p_cv = oof_predictions(train_df, soh_feats, y_train, w_train, cv, mono)
    full = tuple(groups_in(soh_feats))
    cv_base = np.zeros(len(train_df))
    for tr_i, te_i in cv:
        aw, bw = fit_linear_baseline(train_df["cycle"].to_numpy()[tr_i], y_train[tr_i], w_train[tr_i])
        cv_base[te_i] = aw + bw * train_df["cycle"].to_numpy()[te_i] - y_train[te_i]

    # ---------------------------------------------- held-out: measured method
    rng = np.random.default_rng(SEED)
    sim = ev[["cell", "cycle", "y_soh"]].copy()
    n_stale = rng.integers(0, MAX_STALENESS + 1, len(sim))
    noise01 = rng.standard_normal(len(sim))
    read_cycle = np.empty(len(sim))
    read_soh = np.empty(len(sim))
    for c, idx in sim.groupby("cell").groups.items():
        idx = np.asarray(idx)
        cyc = sim["cycle"].to_numpy()[idx]
        ys_ = sim["y_soh"].to_numpy()[idx]
        for j, i in enumerate(idx):
            # The gauge's last Qmax update happened n cycles before this row:
            # use the latest row at or before that cycle (or the first row).
            k = np.searchsorted(cyc, cyc[j] - n_stale[i], side="right") - 1
            k = max(k, 0)
            read_cycle[i] = cyc[k]
            read_soh[i] = ys_[k]
    sim["qmax_update_cycle"] = read_cycle
    sim["cycles_since_update"] = sim["cycle"] - read_cycle
    sim["true_soh_at_update"] = read_soh
    sim["noise_std_normal"] = noise01
    sim["reported_soh_primary"] = read_soh + GAUGE_NOISE_PRIMARY * noise01
    sim["reported_soh_stress"] = read_soh + GAUGE_NOISE_STRESS * noise01
    sim["reported_soh_fresh"] = sim["y_soh"].to_numpy() + GAUGE_NOISE_PRIMARY * noise01
    msim_path = ARTIFACTS / "eval_set_measured.csv"
    sim.to_csv(msim_path, index=False, float_format="%.10g")
    sim = pd.read_csv(msim_path)

    def eval_measured(col: str, stale: bool = True) -> dict:
        mo = [inference.measured_infer(mparams, {"soh_measured": float(r[col]),
                                                "cycles_since_update": float(r["cycles_since_update"]) if stale else 0.0})
              for _, r in sim.iterrows()]
        p = np.array([o["soh_bps"] for o in mo]) / 1e4
        l_ = np.array([o["soh_low_bps"] for o in mo]) / 1e4
        h_ = np.array([o["soh_high_bps"] for o in mo]) / 1e4
        g_ = np.array([o["grade"] for o in mo])
        return {
            "mae_bps": round(float(np.mean(np.abs(p - y)) * 1e4), 1),
            "rmse_bps": round(float(np.sqrt(np.mean((p - y) ** 2)) * 1e4), 1),
            "coverage": round(coverage(y, l_, h_), 4),
            "mean_width_bps": round(float(np.mean(h_ - l_) * 1e4), 1),
            "grades_assigned": {inference.GRADE_NAMES[g]: int(np.sum(g_ == g)) for g in (1, 2, 3, 4)},
            "grades_more_permissive_than_truth": int(np.sum(((g_ == 1) & (y < 0.8)) | ((g_ == 2) & (y < 0.6)))),
            "_lo": l_, "_hi": h_, "_p": p,
        }

    meas_primary = eval_measured("reported_soh_primary")
    meas_stress = eval_measured("reported_soh_stress")
    meas_fresh = eval_measured("reported_soh_fresh", stale=False)
    meas_no_widen = eval_measured("reported_soh_primary", stale=False)
    log(f"measured primary: { {k: v for k, v in meas_primary.items() if not k.startswith('_')} }")

    # ------------------------------------------------- consistency / tamper
    # Measured-fresh: only rows whose simulated update age is within the limit.
    fresh_rows = sim["cycles_since_update"].to_numpy() <= fparams["fresh_cycles"]
    sim_f = sim[fresh_rows].reset_index(drop=True)
    fresh_eval_path = ARTIFACTS / "eval_set_measured_fresh.csv"
    sim_f.to_csv(fresh_eval_path, index=False, float_format="%.10g")
    sim_f = pd.read_csv(fresh_eval_path)
    y_f = sim_f["y_soh"].to_numpy()
    base_f = float(min(np.mean(np.abs(base_w[fresh_rows])), np.mean(np.abs(base_u[fresh_rows]))) * 1e4)

    def eval_fresh(col: str) -> dict:
        mo = [inference.measured_infer(fparams, {"soh_measured": float(r[col]),
                                                 "cycles_since_update": float(r["cycles_since_update"])})
              for _, r in sim_f.iterrows()]
        assert all(o["fresh"] for o in mo)
        p = np.array([o["soh_bps"] for o in mo]) / 1e4
        l_ = np.array([o["soh_low_bps"] for o in mo]) / 1e4
        h_ = np.array([o["soh_high_bps"] for o in mo]) / 1e4
        g_ = np.array([o["grade"] for o in mo])
        return {"rows": int(len(sim_f)),
                "mae_bps": round(float(np.mean(np.abs(p - y_f)) * 1e4), 1),
                "rmse_bps": round(float(np.sqrt(np.mean((p - y_f) ** 2)) * 1e4), 1),
                "baseline_mae_bps_same_rows": round(base_f, 1),
                "coverage": round(coverage(y_f, l_, h_), 4),
                "mean_width_bps": round(float(np.mean(h_ - l_) * 1e4), 1),
                "grades_assigned": {inference.GRADE_NAMES[g]: int(np.sum(g_ == g)) for g in (1, 2, 3, 4)},
                "grades_more_permissive_than_truth": int(np.sum(((g_ == 1) & (y_f < 0.8)) | ((g_ == 2) & (y_f < 0.6))))}

    fresh_primary = eval_fresh("reported_soh_primary")
    fresh_stress = eval_fresh("reported_soh_stress")
    log(f"measured-fresh primary: {fresh_primary}")
    log(f"measured-fresh stress: {fresh_stress}")

    honest = sim["reported_soh_primary"].to_numpy()
    honest_flag = (honest < lo) | (honest > hi)
    tamper = {}
    for d in TAMPER_POINTS:
        tamper[f"+{int(d * 100)}"] = tamper_eval(honest, lo, hi, d, np.random.default_rng(SEED + int(d * 100)))
    log(f"tamper: {tamper}")

    # --------------------------------------------------------------- metrics
    def entry(mae, base, cov_, weights_file, eval_file, verdict_extra, detail):
        m_bps, b_bps, c_bps = int(round(mae)), int(round(base)), int(round(cov_ * 10000))
        ok = (m_bps < b_bps) and (c_bps >= MIN_COVERAGE_BPS)
        reasons = []
        if m_bps >= b_bps:
            reasons.append(f"MAE {m_bps} bps does not beat the baseline {b_bps} bps")
        if c_bps < MIN_COVERAGE_BPS:
            reasons.append(f"coverage {c_bps / 100:.1f}% is below the 85% floor")
        verdict = ("Registrable: beats the baseline and meets the coverage floor." if ok
                   else "Not registrable: " + "; ".join(reasons) + ".") + verdict_extra
        return {
            "maeBps": m_bps, "baselineMaeBps": b_bps, "coverageBps": c_bps, "registrable": ok, "verdict": verdict,
            "weightsFile": weights_file.name, "weightsSha256": sha256_file(weights_file),
            "evalDataFile": eval_file.name, "evalDataSha256": sha256_file(eval_file),
            "registryPayload": {"weightsHash": "0x" + sha256_file(weights_file),
                                "evalDataHash": "0x" + sha256_file(eval_file),
                                "maeBps": m_bps, "baselineMaeBps": b_bps, "coverageBps": c_bps},
            "detail": detail,
        }

    strip = lambda d: {k: v for k, v in d.items() if not k.startswith("_")}  # noqa: E731
    learned_entry = entry(
        mae_bps, baseline_mae, cov, weights_path, eval_path,
        " Every interval is calibrated on other datasets only; NASA was not used to choose anything.",
        {
            "method": "predicts SoH from gauge signals other than the measured capacity",
            "deployment": "Not registered. Used only for remaining-life estimates and for the upper-bound-only "
                          "consistency (tamper) check in the combined grader.",
            "heldout": {"dataset": HELDOUT, "cells": sorted(ev["cell"].unique().tolist()), "rows": int(len(ev))},
            "train_datasets": TRAIN,
            "soh": {"mae_bps": round(mae_bps, 1), "rmse_bps": round(float(np.sqrt(np.mean(err ** 2)) * 1e4), 1),
                    "coverage": round(cov, 4), "target_coverage": 1 - ALPHA,
                    "mean_interval_width_bps": round(float(np.mean(hi - lo) * 1e4), 1),
                    "per_cell": per_cell, "by_feature_pattern": by_pattern,
                    "grades_assigned": grade_counts, "grades_more_permissive_than_truth": permissive},
            "baseline": {"kind": "linear SoH vs cycle count fitted on training cells", **base_info,
                         "weighted_mae_bps": round(base_w_mae, 1), "unweighted_mae_bps": round(base_u_mae, 1),
                         "registry_value": "the lower of the two",
                         "linear_vs_equivalent_full_cycles_mae_bps": round(base_efc_mae, 1)},
            "transfer_and_feature_selection": {"criterion": "LODO MAE between training datasets, lower wins",
                                               "candidates": selection, "chosen": chosen},
            "interval": {"calibration": "pooled leave-one-dataset-out residuals between training datasets",
                         "score": kind, "relative_floor": calibration.RELATIVE_FLOOR,
                         "swap_test": fc["swap"], "q": q_soh},
            "rul": rul_eval, "rul_training": rul_info,
            "leave_one_dataset_out": lodo_all,
            "grouped_cv_on_training": {"mae_bps": round(wmae(y_train - p_cv[full], w_train) * 1e4, 1),
                                       "baseline_mae_bps": round(wmae(cv_base, w_train) * 1e4, 1)},
            "heldout_stress_set": stress,
            "export_check_max_abs_diff": max_diff,
            "hyperparameters": HGB_PARAMS,
        },
    )
    measured_entry = entry(
        meas_primary["mae_bps"], baseline_mae, meas_primary["coverage"], measured_path, msim_path,
        " This method measures SoH from the gauge's capacity; its error is the gauge's error, not a prediction.",
        {
            "method": "measures SoH = capacity / design; interval from TI's stated accuracy plus staleness",
            "accuracy_source": mparams["accuracy_source"],
            "simulation": {"rows": int(len(sim)), "cells": sorted(sim["cell"].unique().tolist()),
                           "staleness": f"cycles since last Qmax update drawn uniformly from 0 to {MAX_STALENESS}",
                           "noise_primary_sigma": GAUGE_NOISE_PRIMARY, "noise_stress_sigma": GAUGE_NOISE_STRESS,
                           "seed": SEED, "file": msim_path.name},
            "primary": strip(meas_primary),
            "stress_noise_1pct_sigma": strip(meas_stress),
            "fresh_reading": {"note": "Qmax updated on this cycle (N = 0), primary noise", **strip(meas_fresh)},
            "stale_reading_without_widening": {"note": "primary readings, staleness ignored", **strip(meas_no_widen)},
            "baseline_note": "same linear baseline and same rows as the learned model",
        },
    )
    fresh_entry = entry(
        fresh_primary["mae_bps"], base_f, fresh_primary["coverage"], fresh_path, fresh_eval_path,
        " Measures SoH from the gauge's capacity and grades only fresh readings; " + DISCLOSURE,
        {
            "method": "measures SoH = capacity / design; graded only when the last Qmax update is at most "
                      f"{fparams['fresh_cycles']} cycles old, otherwise the grader submits BENCH_TEST",
            "disclosure": DISCLOSURE,
            "freshness_limit_cycles": fparams["fresh_cycles"],
            "freshness_source": fparams["freshness_source"],
            "freshness_p90_fade_points_by_staleness": fresh_table,
            "accuracy_source": fparams["accuracy_source"],
            "evaluation_rows": "registered NASA rows whose simulated update age (from eval_set_measured.csv) is "
                               f"0 to {fparams['fresh_cycles']} cycles",
            "rows_not_graded_as_stale": int((~fresh_rows).sum()),
            "primary_noise_0_5pct": fresh_primary,
            "stress_noise_1pct": fresh_stress,
        },
    )
    metrics = {
        "codeCommit": git_commit(),
        "codeCommitNote": "HEAD of the repository when training ran. Commit model/ and re-run before registering "
                          "so codeHash points at the code that produced these numbers.",
        "disclosure": DISCLOSURE,
        "deployed": {"grading": MEASURED_FRESH_ID + " when the last Qmax update is fresh, otherwise BENCH_TEST",
                     "tamper_rule": "flag (and submit BENCH_TEST) when the measured SoH is above the learned "
                                    "model's upper bound",
                     "remaining_life": LEARNED_ID + " RUL80 model"},
        "models": {LEARNED_ID: learned_entry, MEASURED_ID: measured_entry, MEASURED_FRESH_ID: fresh_entry},
        "consistency_check": {
            "rule": "flag when the measured SoH is outside the learned model's interval for the same row",
            "measured_input": "simulated primary gauge readings (eval_set_measured.csv)",
            "false_alarm_rate_on_honest_readings": round(float(honest_flag.mean()), 4),
            "tamper": tamper,
            "note": "half of the rows, chosen at random, have the reported SoH inflated by the stated amount",
        },
        "environment": {"python": platform.python_version(), "sklearn": __import__("sklearn").__version__,
                        "numpy": np.__version__},
        "runtime_seconds": round(time.time() - t0, 1),
    }
    (ARTIFACTS / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")

    # Exactly the ModelRegistry.Model fields, for every model id that would pass register().
    submission = {}
    for mid, e in metrics["models"].items():
        if not e["registrable"]:
            continue
        submission[mid] = {
            "weightsHash": "0x" + e["weightsSha256"],
            "evalDataHash": "0x" + e["evalDataSha256"],
            "codeHash": "0x" + "0" * 64,
            "maeBps": e["maeBps"],
            "baselineMaeBps": e["baselineMaeBps"],
            "coverageBps": e["coverageBps"],
            "registeredAt": 0,
            "active": True,
            "uri": CARD_URI,
        }
    (ARTIFACTS / "registry_submission.json").write_text(json.dumps(submission, indent=2) + "\n")
    for mid, e in metrics["models"].items():
        log(f"{mid}: maeBps {e['maeBps']} baselineMaeBps {e['baselineMaeBps']} coverageBps {e['coverageBps']} "
            f"registrable {e['registrable']}")
        log("  " + e["verdict"])
    log(f"RUL: {json.dumps(rul_eval)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

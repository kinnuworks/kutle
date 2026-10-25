"""Leave-one-dataset-out (LODO) calibration of prediction intervals.

Training-data conformal intervals assume new cells look like the calibration
cells. A battery passport grades packs from a domain the model has not seen,
so the intervals here are built from out-of-domain residuals instead: for each
training dataset, a model is fitted on the other training datasets and its
residuals on the left-out dataset are collected. The pooled residuals set the
interval.

Two score functions are supported:

    absolute   s = |y - yhat|, interval yhat +/- q
    relative   s = |y - yhat| / max(1 - yhat, floor), interval
               yhat +/- q * max(1 - yhat, floor). The width grows with the
               capacity the model thinks has been lost.

Which one to use is decided on the training datasets alone with a swap test:
calibrate on the residuals of one left-out dataset and measure coverage on the
residuals of the other, in both directions. The scheme with the higher worst
case coverage wins; if both reach the target in both directions, the narrower
one wins.
"""

from __future__ import annotations

import numpy as np

from .conformal import conformal_level, weighted_quantile

KINDS = ("absolute", "relative")
RELATIVE_FLOOR = 0.05  # fixed in advance: the scale never drops below 5 SoH points


def scale(pred: np.ndarray, kind: str, floor: float = RELATIVE_FLOOR) -> np.ndarray:
    pred = np.asarray(pred, dtype=float)
    if kind == "absolute":
        return np.ones_like(pred)
    if kind == "relative":
        return np.maximum(1.0 - pred, floor)
    raise ValueError(kind)


def scores(y, pred, kind: str, floor: float = RELATIVE_FLOOR) -> np.ndarray:
    y, pred = np.asarray(y, dtype=float), np.asarray(pred, dtype=float)
    return np.abs(y - pred) / scale(pred, kind, floor)


def quantile(y, pred, kind: str, alpha: float, weights=None, floor: float = RELATIVE_FLOOR) -> float:
    s = scores(y, pred, kind, floor)
    return weighted_quantile(s, conformal_level(s.size, alpha), weights)


def half_width(pred, q: float, kind: str, floor: float = RELATIVE_FLOOR) -> np.ndarray:
    return q * scale(pred, kind, floor)


def swap_test(y, pred, groups, weights, kind: str, alpha: float) -> dict:
    """Calibrate on each left-out group, measure coverage and width on the others."""
    y, pred, groups, weights = (np.asarray(a) for a in (y, pred, groups, weights))
    out = {}
    names = sorted(set(groups.tolist()))
    for cal in names:
        cm = groups == cal
        q = quantile(y[cm], pred[cm], kind, alpha, weights[cm])
        for test in names:
            if test == cal:
                continue
            tm = groups == test
            hw = half_width(pred[tm], q, kind)
            cov = float(np.average(np.abs(y[tm] - pred[tm]) <= hw, weights=weights[tm]))
            out[f"{cal}->{test}"] = {"coverage": round(cov, 4), "mean_width": float(np.average(2 * hw, weights=weights[tm]))}
    return out


def choose_kind(y, pred, groups, weights, alpha: float) -> tuple[str, dict]:
    target = 1.0 - alpha
    report = {k: swap_test(y, pred, groups, weights, k, alpha) for k in KINDS}

    def key(kind):
        covs = [v["coverage"] for v in report[kind].values()]
        widths = [v["mean_width"] for v in report[kind].values()]
        worst = min(covs)
        # Reaching the target in every direction counts the same; then prefer narrow.
        return (min(worst, target), -float(np.mean(widths)))

    best = max(KINDS, key=key)
    return best, report

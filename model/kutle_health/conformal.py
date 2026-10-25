"""Split conformal prediction helpers.

The score is the absolute residual |y - yhat|. Given calibration scores from
data the model did not train on, the interval for a new point is
yhat +/- q, where q is the ceil((n + 1)(1 - alpha)) / n quantile of the scores.
With exchangeable data this covers the truth with probability at least 1 - alpha.

Sample weights are supported so that each dataset (and each cell inside it)
counts equally in the calibration quantile. Without them the dataset with the
most cycles would set the quantile on its own.
"""

from __future__ import annotations

import numpy as np


def conformal_level(n: int, alpha: float) -> float:
    """Finite-sample corrected quantile level, capped at 1."""
    if n <= 0:
        raise ValueError("need at least one calibration score")
    return min(1.0, np.ceil((n + 1) * (1.0 - alpha)) / n)


def weighted_quantile(scores, level: float, weights=None) -> float:
    """Smallest score s such that the weighted share of scores <= s is >= level."""
    s = np.asarray(scores, dtype=float)
    if s.size == 0:
        raise ValueError("empty scores")
    w = np.ones_like(s) if weights is None else np.asarray(weights, dtype=float)
    if w.shape != s.shape or np.any(w < 0) or w.sum() <= 0:
        raise ValueError("bad weights")
    order = np.argsort(s, kind="mergesort")
    s, w = s[order], w[order]
    cum = np.cumsum(w) / w.sum()
    idx = int(np.searchsorted(cum, level - 1e-12, side="left"))
    return float(s[min(idx, s.size - 1)])


def conformal_quantile(residuals, alpha: float = 0.1, weights=None) -> float:
    scores = np.abs(np.asarray(residuals, dtype=float))
    return weighted_quantile(scores, conformal_level(scores.size, alpha), weights)


def coverage(y, lo, hi) -> float:
    y, lo, hi = (np.asarray(a, dtype=float) for a in (y, lo, hi))
    return float(np.mean((y >= lo) & (y <= hi)))

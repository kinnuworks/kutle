"""Export of scikit-learn HistGradientBoostingRegressor models to plain JSON.

The exported form is a list of trees, each stored as parallel arrays:

    f    feature index of the split (-1 on leaves)
    t    numeric threshold; a row goes left when x <= t
    m    1 if a missing value (NaN / null) goes left, else 0
    l, r child node indices
    v    leaf value (0 on internal nodes)

A prediction is the baseline plus the leaf values of every tree, added in tree
order. Only additions and comparisons are involved, so the pure Python and pure
JavaScript evaluators in this repo reproduce scikit-learn's raw prediction to
the last bit.
"""

from __future__ import annotations

import json
import math

import numpy as np


DBL_MAX = 1.7976931348623157e308


def _finite(t: float) -> float:
    """JSON has no Infinity. scikit-learn uses +inf for "every value goes left,
    only missing goes right" splits; the largest double gives the same result
    for every finite input."""
    if math.isinf(t):
        return DBL_MAX if t > 0 else -DBL_MAX
    return t


def export_hgb(model) -> dict:
    """Turn a fitted HistGradientBoostingRegressor into a JSON-ready dict."""
    if getattr(model, "is_categorical_", None) is not None and np.any(model.is_categorical_):
        raise ValueError("categorical features are not supported by the exporter")
    baseline = float(np.asarray(model._baseline_prediction).ravel()[0])
    trees = []
    for stage in model._predictors:
        if len(stage) != 1:
            raise ValueError("only single-output regression is supported")
        nodes = stage[0].nodes
        trees.append(
            {
                "f": [int(n["feature_idx"]) if not n["is_leaf"] else -1 for n in nodes],
                "t": [_finite(float(n["num_threshold"])) if not n["is_leaf"] else 0.0 for n in nodes],
                "m": [int(n["missing_go_to_left"]) if not n["is_leaf"] else 0 for n in nodes],
                "l": [int(n["left"]) if not n["is_leaf"] else -1 for n in nodes],
                "r": [int(n["right"]) if not n["is_leaf"] else -1 for n in nodes],
                "v": [float(n["value"]) if n["is_leaf"] else 0.0 for n in nodes],
            }
        )
    out = {"baseline": baseline, "trees": trees}
    json.dumps(out, allow_nan=False)  # raises if any other non-finite value slipped through
    return out


def _is_missing(x) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


def tree_value(tree: dict, row: list) -> float:
    i = 0
    f, t, m, l, r, v = tree["f"], tree["t"], tree["m"], tree["l"], tree["r"], tree["v"]
    while f[i] != -1:
        x = row[f[i]]
        if _is_missing(x):
            i = l[i] if m[i] else r[i]
        elif x <= t[i]:
            i = l[i]
        else:
            i = r[i]
    return v[i]


def predict_raw(exported: dict, row: list) -> float:
    """Pure Python evaluation of one row. Missing values may be None or NaN."""
    acc = exported["baseline"]
    for tree in exported["trees"]:
        acc = acc + tree_value(tree, row)
    return acc

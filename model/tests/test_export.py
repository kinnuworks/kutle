import json
import math

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor

from kutle_health.gbm import export_hgb, predict_raw


def test_json_round_trip_matches_sklearn_exactly():
    rng = np.random.default_rng(1)
    X = rng.random((800, 4))
    X[rng.random(800) < 0.2, 1] = np.nan
    X[rng.random(800) < 0.1, 3] = np.nan
    y = X[:, 0] * 2 + np.nan_to_num(X[:, 1]) - X[:, 2] ** 2 + rng.normal(0, 0.05, 800)
    m = HistGradientBoostingRegressor(max_iter=50, max_leaf_nodes=15, loss="absolute_error", random_state=0)
    m.fit(X, y)
    text = json.dumps(export_hgb(m))
    back = json.loads(text)
    Xt = rng.random((300, 4))
    Xt[::3, 1] = np.nan
    Xt[::5, 3] = np.nan
    sk = m.predict(Xt)
    for row, expected in zip(Xt, sk):
        got = predict_raw(back, [None if math.isnan(v) else float(v) for v in row])
        assert got == expected  # bit for bit
    assert "Infinity" not in text and "NaN" not in text
    # NaN and None are treated the same
    row = [0.3, float("nan"), 0.5, None]
    assert predict_raw(back, row) == predict_raw(back, [0.3, None, 0.5, None])

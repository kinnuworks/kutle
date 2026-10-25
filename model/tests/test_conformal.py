import numpy as np
import pytest

from kutle_health.conformal import conformal_level, conformal_quantile, coverage, weighted_quantile


def test_level_is_finite_sample_corrected():
    assert conformal_level(9, 0.1) == 1.0
    assert conformal_level(99, 0.1) == pytest.approx(90 / 99)
    assert conformal_level(1000, 0.1) == pytest.approx(901 / 1000)


def test_weighted_quantile():
    s = np.arange(1, 11, dtype=float)
    assert weighted_quantile(s, 0.5) == 5
    assert weighted_quantile(s, 0.9) == 9
    assert weighted_quantile(s, 1.0) == 10
    w = np.r_[np.full(9, 1.0), 9.0]  # the last score carries half the weight
    assert weighted_quantile(s, 0.5, w) == 9
    assert weighted_quantile(s, 0.51, w) == 10


def test_split_conformal_covers_on_exchangeable_data():
    rng = np.random.default_rng(0)
    hits = []
    for _ in range(200):
        cal = rng.standard_t(3, 300)
        test = rng.standard_t(3, 300)
        q = conformal_quantile(cal, alpha=0.1)
        hits.append(coverage(test, -q, q))
    assert np.mean(hits) >= 0.89


def test_coverage_counts_endpoints():
    assert coverage([1, 2, 3], [1, 0, 4], [1, 5, 5]) == pytest.approx(2 / 3)

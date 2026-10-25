import numpy as np

from kutle_health import calibration


def two_domains(rng, n=2000):
    """Domain A has small errors, domain B large ones that grow with fade."""
    pred_a = rng.uniform(0.7, 1.0, n)
    pred_b = rng.uniform(0.7, 1.0, n)
    y_a = pred_a + rng.normal(0, 0.01, n)
    y_b = pred_b + rng.normal(0, 1.0, n) * 0.3 * (1 - pred_b)
    y = np.r_[y_a, y_b]
    pred = np.r_[pred_a, pred_b]
    groups = np.array(["a"] * n + ["b"] * n)
    return y, pred, groups, np.ones(2 * n)


def test_scores_and_half_width_are_inverse():
    pred = np.array([0.99, 0.9, 0.6])
    y = np.array([0.97, 0.8, 0.7])
    for kind in calibration.KINDS:
        s = calibration.scores(y, pred, kind)
        hw = calibration.half_width(pred, 1.0, kind) * s
        np.testing.assert_allclose(hw, np.abs(y - pred))
    # relative scale has a floor
    assert calibration.scale(np.array([0.99]), "relative")[0] == calibration.RELATIVE_FLOOR


def test_swap_test_calibrates_on_one_group_and_tests_on_the_other():
    rng = np.random.default_rng(0)
    y, pred, groups, w = two_domains(rng)
    rep = calibration.swap_test(y, pred, groups, w, "absolute", 0.1)
    assert set(rep) == {"a->b", "b->a"}
    # calibrating on the easy domain under-covers the hard one, and the reverse over-covers
    assert rep["a->b"]["coverage"] < 0.5
    assert rep["b->a"]["coverage"] > 0.99


def test_choose_kind_prefers_relative_when_errors_scale_with_fade():
    rng = np.random.default_rng(1)
    n = 3000
    # domain a holds young cells, domain b aged ones; the error scales with fade in both
    pred = np.r_[rng.uniform(0.9, 1.0, n), rng.uniform(0.6, 0.8, n)]
    y = pred + rng.normal(0, 1.0, 2 * n) * 0.2 * np.maximum(1 - pred, 0.05)
    groups = np.array(["a"] * n + ["b"] * n)
    kind, rep = calibration.choose_kind(y, pred, groups, np.ones(2 * n), 0.1)
    assert kind == "relative"
    assert all(v["coverage"] > 0.85 for v in rep["relative"].values())
    assert min(v["coverage"] for v in rep["absolute"].values()) < 0.85


def test_pooled_quantile_covers_pooled_residuals():
    rng = np.random.default_rng(2)
    y, pred, groups, w = two_domains(rng)
    for kind in calibration.KINDS:
        q = calibration.quantile(y, pred, kind, 0.1, w)
        hw = calibration.half_width(pred, q, kind)
        assert np.mean(np.abs(y - pred) <= hw) >= 0.9

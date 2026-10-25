import numpy as np

from kutle_health.consistency import flag, flag_upper, tamper_eval


def test_flag_marks_values_outside_interval():
    f = flag([0.5, 0.8, 0.95, 0.7], [0.6, 0.6, 0.6, 0.7], [0.9, 0.9, 0.9, 0.7])
    assert f.tolist() == [True, False, True, False]


def test_tamper_detection_with_narrow_intervals():
    rng = np.random.default_rng(0)
    truth = rng.uniform(0.7, 0.95, 4000)
    lo, hi = truth - 0.02, truth + 0.02
    measured = truth + rng.normal(0, 0.005, truth.size)
    r = tamper_eval(measured, lo, hi, 0.10, np.random.default_rng(1))
    assert r["detection_rate"] == 1.0
    assert r["false_alarm_rate"] < 0.001
    assert abs(r["tampered_rows"] - 2000) < 150


def test_tamper_detection_fails_with_wide_intervals():
    rng = np.random.default_rng(0)
    truth = rng.uniform(0.7, 0.95, 4000)
    lo, hi = truth - 0.3, truth + 0.3
    r = tamper_eval(truth, lo, hi, 0.05, np.random.default_rng(1))
    assert r["detection_rate"] == 0.0 and r["false_alarm_rate"] == 0.0


def test_upper_bound_rule_ignores_low_readings():
    assert flag_upper([0.5, 0.95, 0.9], [0.9, 0.9, 0.9]).tolist() == [False, True, False]

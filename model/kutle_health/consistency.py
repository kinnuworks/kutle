"""Consistency check between the measured SoH and the learned model.

The learned model never sees the reported capacity. If the gauge's measured SoH
falls outside the learned model's interval for the same cell state (cycle
count, resistance growth and so on), the two disagree and the reading is
flagged. This is the check that docs/SECURITY.md section 2.2 relies on for a
gauge that reports a higher capacity than the cell has.

The deployed rule is one-sided (flag_upper): only a measured SoH above the
learned upper bound is flagged, because the two-sided rule raised false alarms
on most honest NASA readings.

tamper_eval measures it as a detector: a random half of the rows has the
reported SoH inflated by a fixed amount, and the detection rate (flagged among
tampered rows) and false-alarm rate (flagged among honest rows) are reported.
"""

from __future__ import annotations

import numpy as np


def flag_upper(measured, high) -> np.ndarray:
    """Deployed tamper rule: True where the measured value is above the learned upper bound."""
    return np.asarray(measured, dtype=float) > np.asarray(high, dtype=float)


def flag(measured, low, high) -> np.ndarray:
    """True where the measured value is outside [low, high]."""
    m, lo, hi = (np.asarray(a, dtype=float) for a in (measured, low, high))
    return (m < lo) | (m > hi)


def tamper_eval(measured, low, high, inflate: float, rng, share: float = 0.5) -> dict:
    m = np.asarray(measured, dtype=float).copy()
    lo, hi = np.asarray(low, dtype=float), np.asarray(high, dtype=float)
    tampered = rng.random(m.size) < share
    m[tampered] += inflate
    f = flag(m, lo, hi)
    upper_only = m > hi
    honest = ~tampered
    return {
        "inflate_points": round(inflate * 100, 1),
        "tampered_rows": int(tampered.sum()),
        "honest_rows": int(honest.sum()),
        "detection_rate": round(float(f[tampered].mean()), 4) if tampered.any() else None,
        "false_alarm_rate": round(float(f[honest].mean()), 4) if honest.any() else None,
        "detection_rate_upper_bound_only": round(float(upper_only[tampered].mean()), 4) if tampered.any() else None,
        "false_alarm_rate_upper_bound_only": round(float(upper_only[honest].mean()), 4) if honest.any() else None,
    }

"""Measured-capacity SoH method (a separate model id from the learned model).

This method measures; the learned model predicts. A smart-battery gauge with
TI Impedance Track learns the cell's chemical capacity (Qmax) from its own
current integration between rested open-circuit voltage readings, and derives
the full charge capacity from it. In the lab datasets the measured discharge
capacity plays that role. The method reports

    soh_measured = capacity / design capacity

with an interval made of two parts:

  * gauge accuracy: +/- ACCURACY. TI's product page for the bq20z80 Impedance
    Track gauge states "Better than 1% Error Over Lifetime of the Battery"
    (https://www.ti.com/product/bq20z80; algorithm described in TI application
    note SLUA364, "Theory and Implementation of Impedance Track Battery
    Fuel-Gauging Algorithm in bq20zxx Product Family"). That is a vendor figure
    for available capacity under TI's test conditions; it is used here as a
    1 point bound on SoH.
  * staleness: if Qmax was last updated N cycles ago the capacity can only have
    fallen since, so the lower bound drops by N times the 90th percentile of
    per-cycle fade seen in the training data, and the point estimate by N times
    the median fade.

The arithmetic matches measured_infer in inference.py and js/infer.mjs.
"""

from __future__ import annotations

ACCURACY = 0.01
FRESH_CYCLES = 50  # a Qmax update at most this many cycles old counts as fresh


def params(fade_median_per_cycle: float, fade_p90_per_cycle: float) -> dict:
    return {
        "format": "kutle-measured-soh-v1",
        "description": "SoH = measured capacity / design capacity, interval from gauge accuracy plus staleness.",
        "accuracy": ACCURACY,
        "accuracy_source": "TI bq20z80 product page: 'Better than 1% Error Over Lifetime of the Battery'; TI SLUA364",
        "fade_median_per_cycle": fade_median_per_cycle,
        "fade_p90_per_cycle": fade_p90_per_cycle,
        "fade_source": "per-cycle SoH fade over 50-cycle windows in the training datasets, each dataset weighted equally",
        "fresh_cycles": FRESH_CYCLES,
    }

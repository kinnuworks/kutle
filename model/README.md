# Kutle battery health model

This folder holds the two methods that grade a battery for its passport and
the grader that combines them. The model card is `artifacts/MODEL_CARD.md`.

- `kutle-soh-learned-v2` predicts state of health (SoH) from the cycle counter
  and resistance growth, without seeing the measured capacity, and predicts
  remaining useful life (RUL) to 80% and 60% SoH.
- `kutle-soh-measured-v1` measures SoH as capacity over design capacity, with
  an interval from TI's stated Impedance Track accuracy plus staleness.
- The combined grader uses the measured interval when the gauge's last Qmax
  update is fresh and the learned one otherwise, and flags a measured SoH that
  falls outside the learned interval.

## Results in one paragraph

On held-out NASA cells neither method can be registered. The learned model
beats the linear baseline (1819 vs 1928 bps MAE) but its interval, now
calibrated only on out-of-domain residuals, covers 12.6% of rows. The measured
method has 240 bps MAE but 58.9% coverage, because readings up to 30 cycles
stale on fast-fading NASA cells exceed the staleness allowance taken from the
training data; with fresh readings it covers 95.0% at 40 bps MAE. The
consistency check flags 80% of honest readings as a two-sided test; checking
only the upper bound gives no false alarms and catches 39% of +20 point
inflations. On the demo Mac the two methods agree (learned 95.2%, measured
94.8%) and the combined grader submits REUSE from the measured interval.

## Layout

```
data/download.py          fetch datasets, record and verify SHA-256 checksums
data/SOURCES.md           licences and citations
data/checksums.json       checksums recorded on first download
data/raw/                 downloaded data (gitignored)
kutle_health/             loaders, features, training, calibration, export, inference
  calibration.py          leave-one-dataset-out interval calibration and swap test
  measured.py             measured-capacity method parameters
  consistency.py          consistency flag and tamper evaluation
js/infer.mjs              dependency-free JavaScript inference for both methods
scripts/grade_this_mac.py combined grader on this Mac's battery
artifacts/                model.json, measured_method.json, metrics.json,
                          eval_set.csv, eval_set_measured.csv, MODEL_CARD.md
tests/                    pytest suite
```

## Reproduce

Python 3.12 and Node 18 or later.

```
cd model
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 1. Download (about 2.7 GB; the Severson batch is 2.0 GB). Safe to re-run.
.venv/bin/python data/download.py

# 2. Train, select, calibrate, evaluate and export (about 4 minutes on an
#    M-series laptop, plus about 2 minutes the first time to parse CALCE)
.venv/bin/python -m kutle_health.train

# 3. Tests, including Python and JavaScript parity on 50 inputs
.venv/bin/python -m pytest -q tests

# 4. Grade this Mac
.venv/bin/python scripts/grade_this_mac.py
```

Training is deterministic: repeated runs produce byte-identical `model.json`,
`measured_method.json`, `eval_set.csv` and `eval_set_measured.csv`. Parsed
datasets are cached in `data/raw/processed/`. The CALCE server stalls often;
the downloader resumes and retries, and one process per cell
(`--only calce --calce-cells CS2_35`) was much faster than one process for all.

## Data

| Dataset | Cells | Chemistry | Role |
| --- | --- | --- | --- |
| CALCE CS2, CX2 | 10 (CS2_33 to 38, CX2_34, 36, 37, 38) | LCO prismatic, 1.1 and 1.35 Ah | training |
| Severson et al. 2019, batch 2017-06-30 | 43 | LFP 18650, 1.1 Ah | training |
| NASA PCoE | 6 registered, 17 stress | 18650, 2 Ah | held out |

All three sources downloaded. Only one of the three Severson batches is used
by default; `--severson-batches` adds the others. The registered NASA cells are
those run at 24 C ambient whose first clean capacity is at least 80% of rating
(B0005, B0006, B0007, B0018, B0034, B0036), a rule fixed from the data
description before any model output on NASA was seen.

## Protocol

Everything below was chosen on CALCE and Severson alone. NASA was used once,
for the final evaluation.

Features are per discharge cycle and use only the current and earlier cycles.
The register behind each feature is documented in `kutle_health/features.py`.

Transfer choices. Twelve configurations were compared by leave-one-dataset-out
(LODO) MAE between the two training datasets: three feature sets, raw cycle
count or equivalent full cycles, with or without monotone constraints.

| Configuration | LODO MAE | Grouped CV MAE |
| --- | --- | --- |
| cycle, resistance, monotone (chosen) | 724 bps | 267 bps |
| cycle, resistance, unconstrained (v1) | 734 bps | 249 bps |
| efc, resistance, monotone | 738 bps | 276 bps |
| efc, resistance, unconstrained | 750 bps | 256 bps |
| plus temperature and voltage, best of four | 896 bps | 220 bps |
| plus C-rates, best of four | 898 bps | 191 bps |

Equivalent full cycles did not help, because every lab cycle is already a full
cycle. Temperature-corrected resistance could not be tried: CALCE has no
temperature channel. All twelve rows are in `metrics.json`.

Learned intervals are split conformal on pooled LODO residuals (fit on one
training dataset, residuals on the other), per pattern of optional inputs,
target 90%. Absolute and relative scores were compared with a swap test
(calibrate on one left-out dataset, test on the other); the relative score
yhat +/- q max(1 - yhat, 0.05) won on worst-case coverage (53.7% against
47.3%). RUL80 uses LODO calibration on sqrt(cycles); RUL60 can only be
calibrated in-distribution because only CALCE reaches 60%.

The measured method uses TI's figure for Impedance Track, "Better than 1% Error
Over Lifetime of the Battery" (bq20z80 product page,
https://www.ti.com/product/bq20z80; algorithm in TI application note SLUA364),
as a 1 point bound, and widens the lower bound by the training data's 90th
percentile fade (0.128 points per cycle) times the cycles since the last Qmax
update. The point estimate subtracts the median fade (0.030 points per cycle)
times the same count.

## Results

`artifacts/metrics.json` has one entry per model id.

| | kutle-soh-learned-v2 | kutle-soh-measured-v1 |
| --- | --- | --- |
| maeBps | 1819 | 240 |
| baselineMaeBps | 1928 | 1928 |
| coverageBps | 1261 | 5894 |
| registrable | false | false |
| mean interval width | 1555 bps | 386 bps |

The baseline is a straight line of SoH against cycle count fitted on the
training cells, weighted like the model (1928 bps) and unweighted (1954 bps);
the registry gets the lower. Both methods are evaluated on the same 1023 rows.

Learned model, more detail:

| Evaluation | Model MAE | Baseline MAE | Coverage | Mean width |
| --- | --- | --- | --- | --- |
| NASA registered | 1819 | 1928 | 12.6% | 1555 |
| CALCE held out (trained on NASA, Severson) | 1251 | 989 | 98.7% | 7994 |
| Severson held out (trained on CALCE, NASA) | 772 | 972 | 100% | 8327 |
| grouped CV on training cells | 267 | 450 | | |
| NASA stress set, 17 cells | 3139 | 3337 | 0.6% | |

RUL on NASA: to 80%, 117 cycles MAE (median 56) against 114 for the
extrapolation baseline, 75.6% coverage; to 60% (one cell), 690 against 240,
0% coverage. The RUL models do not beat the baseline.

Coverage fell from v1's 59.4% to 12.6%. The relative score narrows the interval
when the model thinks the cell is young, and NASA cells fade much faster than
their cycle count implies, so the model is most wrong where its interval is
narrowest. The swap test already showed the two training datasets disagree too
much for any calibration built from them to hold on a third dataset.

Measured method on NASA, using the lab capacity as the gauge reading with noise
and staleness drawn at random (saved in `eval_set_measured.csv`):

| Scenario | MAE | Coverage | Mean width |
| --- | --- | --- | --- |
| registered: noise sigma 0.5%, stale 0 to 30 cycles | 240 bps | 58.9% | 386 bps |
| noise sigma 1%, stale 0 to 30 cycles | 253 bps | 53.8% | 386 bps |
| fresh reading, noise sigma 0.5% | 40 bps | 95.0% | 200 bps |
| stale readings, no staleness widening | 269 bps | 30.5% | 200 bps |

NASA cells fade about 0.16 points per cycle, above the training 90th percentile
of 0.128, so the staleness allowance is too small for them. It was not
adjusted.

Consistency check as a tamper detector on NASA (half the rows inflated):

| Inflation | Detection | False alarms | Detection, upper bound only | False alarms, upper bound only |
| --- | --- | --- | --- | --- |
| +5 points | 62.2% | 79.3% | 2.1% | 0% |
| +10 points | 45.2% | 81.3% | 7.4% | 0% |
| +20 points | 49.9% | 82.3% | 39.0% | 0% |

The two-sided rule is useless here because the learned interval misses most
honest values. The upper-bound rule is quiet on honest data and catches large
inflation some of the time.

Registry payloads, with hashes, are under `models.<id>.registryPayload` in
`metrics.json`. `codeHash` should be the commit that contains this folder:
commit, re-run training (the artifact hashes do not change) and register with
that commit.

## This Mac

```
.venv/bin/python scripts/grade_this_mac.py
```

Output on the demo MacBook Air (bq40z651, 3 cells, cycle 170, last Qmax update
at cycle 169), shortened:

```
Learned model (predicts; does not see the measured capacity)
  SoH            95.2%   interval 79.3% to 104.8% (width 25.4 points)
  grade          BENCH_TEST
  outside training range: r_ratio
Measured method (measures: full charge capacity / design capacity)
  measured       94.8%, cycles since last Qmax update: 1 (fresh, limit 50)
  SoH            94.8%   interval 93.7% to 95.8%
  grade          REUSE
Consistency check
  measured SoH is inside the learned interval: no flag
Submitted by the combined grader
  source         measured (fresh Qmax)
  interval       93.7% to 95.8%
  grade          REUSE
Remaining useful life (learned RUL models, from the measured SoH)
  to 80% SoH     430 cycles  (interval 103 to 894)
  to 60% SoH     705 cycles  (interval 282 to 1672)
```

The measured value uses AppleRawMaxCapacity (full charge capacity). The
per-cell Qmax values read about 104% of design because Qmax is the low-rate
chemical capacity. The learned interval sweeps the unknown first-use
resistance from 1.0 to 1.5 times; pass `--r0-mohm` if the first-use
`WeightedRa` is known. The REUSE grade rests on the gauge's measurement and
TI's accuracy figure. The learned model only confirms it is not wildly off.

## What did not work

- Out-of-domain calibration with two training datasets. The swap test shows
  that calibrating on either one fails on the other, and NASA confirms it.
- Equivalent full cycles, and the temperature, voltage-curve and C-rate
  features, all of which transferred worse between datasets.
- The staleness allowance for the measured method on fast-fading cells.
- The two-sided consistency check as a tamper detector.
- RUL to 60%, with nine training cells from one dataset.

# Kutle battery health methods

Two methods produce the `sohBps`, `lowBps` and `highBps` values that
`PassportRegistry` records for EU battery passports (Regulation (EU)
2023/1542). They are registered under separate model ids because they do
different things.

- `kutle-soh-learned-v2` predicts. It estimates state of health from gauge
  signals that do not include the measured capacity (cycle count and
  resistance growth), using gradient boosted trees trained on lab cells. It
  also carries the remaining useful life (RUL) models.
- `kutle-soh-measured-v1` measures. It takes the capacity the gauge reports,
  divides by design capacity, and puts an interval around it from the gauge's
  stated accuracy and from how stale the last capacity update is. Its accuracy
  is the gauge's accuracy. It adds no knowledge about ageing.

- `kutle-soh-measured-fresh-v1` is the measured method restricted to readings
  whose last Qmax update is at most 5 cycles old. Staler readings are not
  graded by it, and the grader submits BENCH_TEST.

Deployed configuration: the grader uses `kutle-soh-measured-fresh-v1` when the
reading is fresh and submits BENCH_TEST otherwise. The learned model is not
registered. It is used only for remaining-life estimates and for the tamper
rule, which flags a measured SoH above the learned model's upper bound and then
also submits BENCH_TEST.

Disclosure: `kutle-soh-measured-fresh-v1` and its freshness rule were adopted
after the first NASA evaluation of `kutle-soh-measured-v1` showed that the
staleness allowance taken from training data under-covers fast-fading cells.
The 5-cycle limit was set from training data only, but the decision to add a
freshness rule came after seeing NASA results, so its NASA numbers are not a
clean held-out test. The earlier results are kept unchanged below and in
`metrics.json`.

## Summary of results on held-out NASA cells

| Model id | MAE | Baseline MAE | Coverage | Mean width | Registrable |
| --- | --- | --- | --- | --- | --- |
| kutle-soh-learned-v2 | 1819 bps | 1928 bps | 12.6% | 1555 bps | no (coverage) |
| kutle-soh-measured-v1 | 240 bps | 1928 bps | 58.9% | 386 bps | no (coverage) |
| kutle-soh-measured-fresh-v1 (211 fresh rows) | 113 bps | 1803 bps | 71.6% | 232 bps | no (coverage) |

None passes `ModelRegistry.register`: all beat the baseline and all fall short
of the 85% coverage floor, so `registry_submission.json` is empty and
`PassportRegistry.recordHealth` would reject any grade until a model is
registered. The measured method's shortfall comes from
staleness. With a fresh capacity reading its coverage is 95.0% (MAE 40 bps),
but in the registered scenario the last update is up to 30 cycles old and NASA
cells fade faster per cycle than the training cells it took its staleness
allowance from. Nothing was widened after looking at NASA.

## Learned model (kutle-soh-learned-v2)

### Intended use

A second opinion that does not depend on the gauge's capacity figure, and the
fallback when no fresh capacity measurement exists. With its current interval
widths it grades every held-out row BENCH_TEST, which is the correct output for
a model this uncertain.

### Inputs and transfer choices

Inputs: cycle count (SBS `CycleCount()` 0x17) and resistance growth ratio
(current resistance over the value at first use; Impedance Track Ra table,
Apple `WeightedRa`). SoH is constrained to be non-increasing in both.

Twelve configurations were compared by leave-one-dataset-out (LODO) MAE
between the two training datasets, without touching NASA: three feature sets
(cycle and resistance; plus temperature and voltage-curve change; plus
lifetime C-rates), two cycle counters (raw cycle count, equivalent full
cycles), with and without monotone constraints.

| Configuration | LODO MAE | CALCE left out | Severson left out | Grouped CV MAE |
| --- | --- | --- | --- | --- |
| cycle, resistance, monotone (chosen) | 724 | 1131 | 317 | 267 |
| cycle, resistance, unconstrained (v1) | 734 | 1137 | 331 | 249 |
| efc, resistance, monotone | 738 | 1132 | 343 | 276 |
| efc, resistance, unconstrained | 750 | 1149 | 351 | 256 |
| plus temperature and voltage, best variant | 896 | 1208 | 584 | 220 |
| plus C-rates, best variant | 898 | 1169 | 627 | 191 |

All values in bps. For cycle and resistance, the monotone constraint helped slightly between datasets
and cost a little within them. Equivalent full cycles did not help: in these
lab datasets every cycle is a full cycle, so the two counters differ only by
the average SoH. Temperature-corrected resistance was not tried because CALCE
has no temperature channel to correct with. The richer feature sets fit
training cells better and transfer worse, as in v1.

### Interval calibration

The interval comes from pooled out-of-domain residuals: a model fitted on
Severson predicting CALCE, and one fitted on CALCE predicting Severson. Two
score functions were compared with a swap test (calibrate on one left-out
dataset, test on the other):

| Score | CALCE calibrates, Severson tested | Severson calibrates, CALCE tested |
| --- | --- | --- |
| absolute, yhat +/- q | 100% coverage, width 5439 bps | 47.3%, width 1172 bps |
| relative, yhat +/- q max(1 - yhat, 0.05) | 99.3%, width 3311 bps | 53.7%, width 1817 bps |

The rule picks the higher worst-case coverage, so the relative score was used.
The swap test already showed that two training datasets disagree too much for
any calibration to be trusted on a third: whichever dataset calibrates, the
other one is over- or under-covered.

### Results

Registered held-out set: NASA B0005, B0006, B0007, B0018, B0034, B0036 (24 C
ambient, first clean capacity at least 80% of rating), 1023 rows. Rule fixed
from the data description before any model output on NASA was seen.

| Metric | Value |
| --- | --- |
| SoH MAE / RMSE | 1819 / 2019 bps |
| Baseline MAE (linear SoH vs cycle count, lower of weighted 1928 and unweighted 1954) | 1928 bps |
| Coverage, target 90% | 12.6% |
| Mean interval width | 1555 bps |
| Grades | 1023 BENCH_TEST, none more permissive than the truth |
| RUL80 MAE (6 cells), baseline 114 | 117 cycles, coverage 75.6% |
| RUL60 MAE (1 cell), baseline 240 | 690 cycles, coverage 0% |

Coverage is lower than v1's 59.4%. v1 used the larger of an in-distribution
and a between-dataset absolute quantile. The relative score chosen here
narrows the interval when the model believes the cell is young, and NASA cells
lose capacity much faster than their cycle count suggests, so the model is
most wrong exactly where its interval is narrowest.

The same procedure with each dataset held out in turn: NASA 1819 vs 1928 bps,
12.6% coverage; CALCE 1251 vs 989 bps (worse than baseline), 98.7% coverage at
a width of 7994 bps; Severson 772 vs 972 bps, 100% at 8327 bps. Grouped CV on
the training cells: 267 vs 450 bps. NASA stress set (17 cells at 4, 43 or 44
C, or starting below 80%): 3139 vs 3337 bps, 0.6% coverage.

## Measured method (kutle-soh-measured-v1)

### Method

    soh_measured = capacity / design capacity
    point        = soh_measured - N x 0.030 points per cycle
    low          = soh_measured - 1 point - N x 0.128 points per cycle
    high         = soh_measured + 1 point

N is the number of cycles since the gauge last updated Qmax. The 1 point
accuracy is TI's published figure for Impedance Track gauges: the bq20z80
product page states "Better than 1% Error Over Lifetime of the Battery"
(https://www.ti.com/product/bq20z80; the algorithm is described in TI
application note SLUA364). It is a vendor figure for available capacity under
TI's test conditions, used here as a bound on SoH error. The fade rates are the
median and 90th percentile of per-cycle fade over 50-cycle windows in the
training data, each dataset weighted equally. A reading counts as fresh when N
is at most 50.

### Evaluation on NASA

The lab capacity stands in for the gauge's measurement. For each held-out row a
staleness N is drawn uniformly from 0 to 30 cycles, the capacity from the row N
cycles earlier is taken as the gauge's last update, and Gaussian noise is added.
The simulated readings are saved in `eval_set_measured.csv`.

| Scenario | MAE | Coverage | Mean width | Grades more permissive than truth |
| --- | --- | --- | --- | --- |
| registered: noise sigma 0.5%, stale 0 to 30 cycles | 240 bps | 58.9% | 386 bps | 39 of 1023 |
| noise sigma 1%, stale 0 to 30 cycles | 253 bps | 53.8% | 386 bps | 37 |
| fresh reading (N = 0), noise sigma 0.5% | 40 bps | 95.0% | 200 bps | 0 |
| stale readings, no staleness widening | 269 bps | 30.5% | 200 bps | 75 |

The baseline on the same rows is 1928 bps. The 0.5% noise reads TI's 1% as
roughly a two-sigma bound; the 1% case reads it as one sigma.

The staleness allowance is too small for NASA. Those cells lose about 0.16
points per cycle, more than the 90th percentile of the training data (0.128),
and NASA capacity also jumps after rest periods. The rule in the protocol was
to take the fade rate from training data, so it was not adjusted.

### What it does not do

It does not predict ageing, it cannot detect a gauge that lies, and its
accuracy depends on Impedance Track having had recent Qmax updates, which need
rested open-circuit voltage readings at suitable states of charge.

## Measured-fresh method (kutle-soh-measured-fresh-v1)

### Freshness limit

TI documents when Impedance Track can update Qmax: two open-circuit voltage
readings taken after the cell has relaxed, outside disqualified voltage ranges,
with at least 37% of capacity passed between them by default (TI Analog
Applications Journal SLYT402; application note SLUA364). TI gives no cycle age
after which a Qmax value stops being valid. The limit was therefore taken from
the training data: the largest staleness N at which the 90th percentile of
training-cell fade over N cycles (centered 5-cycle median SoH, datasets
weighted equally) stays within the 1 point gauge accuracy.

| Staleness (cycles) | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| 90th percentile fade (points) | 0.19 | 0.39 | 0.60 | 0.78 | 0.95 | above 1 |

N = 5 cycles. Within that window the interval formula is the same as
`kutle-soh-measured-v1`; outside it the method does not grade.

### Evaluation on NASA

Rows from `eval_set_measured.csv` whose simulated update age is 0 to 5 cycles:
211 of the 1023 registered rows (`eval_set_measured_fresh.csv`). The other 812
would not be graded by this method.

| Gauge noise | MAE | Baseline MAE, same rows | Coverage | Mean width | Grades more permissive than truth |
| --- | --- | --- | --- | --- | --- |
| sigma 0.5% (registered) | 113 bps | 1803 bps | 71.6% | 232 bps | 3 of 211 |
| sigma 1% | 133 bps | 1803 bps | 61.6% | 232 bps | 3 of 211 |

Coverage still falls short of 85%. With the update on the same cycle,
coverage is 95.0% (see the measured method above); at 3 to 5 cycles of age
fewer than half the readings stay within 1 point of the truth, because NASA
cells often lose more than a point in three cycles and their capacity jumps
back after rest periods. The limit was not tightened after seeing this.

## Consistency check

Rule: flag a reading when the measured SoH falls outside the learned interval
for the same row. Evaluated on NASA with the registered simulated readings:
half of the rows, chosen at random, had the reported SoH inflated.

| Inflation | Detection rate | False-alarm rate | Detection, upper bound only | False alarms, upper bound only |
| --- | --- | --- | --- | --- |
| none (honest readings) | n/a | 80.2% | n/a | 0% |
| +5 points | 62.2% | 79.3% | 2.1% | 0% |
| +10 points | 45.2% | 81.3% | 7.4% | 0% |
| +20 points | 49.9% | 82.3% | 39.0% | 0% |

As a two-sided check it does not work on NASA: the learned interval misses the
honest value 80% of the time, so most alarms are false. The deployed tamper
rule is therefore the upper-bound-only check: flag a reported SoH higher than
the learned model allows, and submit BENCH_TEST for that reading. On these rows
it raised 0% false alarms and detected 2.1% of +5 point, 7.4% of +10 point and
39.0% of +20 point inflations. It covers part of the risk in docs/SECURITY.md
section 2.2, and only for gross inflation.

## Data

Training: CALCE CS2 and CX2 (10 LCO prismatic cells, room temperature, CC-CV
charge at about 0.5C, 0.5C or 1C discharge, cycled to 30% to 60% of rating)
and Severson et al. 2019 batch 2017-06-30 (43 LFP 18650 cells, multi-step fast
charging with peak rates of 4C to 6C, 4C discharge, 30 C chamber, cycled to
about 75%). Held out: NASA PCoE. Licences and citations in `data/SOURCES.md`.

## Files and hashes

| File | Role | SHA-256 |
| --- | --- | --- |
| measured_fresh_method.json | measured-fresh method parameters | fa4c1e993c3973f2e72322a2a1cbf9f9eb1775e83c0424b6e05a6c0e6c7b4eb1 |
| eval_set_measured_fresh.csv | fresh rows used to evaluate it | f8d7169c4ec2eb6de6bd673df4384fefa8831c85a458bca906883454356f4d52 |
| model.json | learned model weights and interval tables | cf67878a0b59f596b4994252063c03d45bfe3a62c4a52ceca53ff4a751fc112d |
| eval_set.csv | learned model evaluation rows | 265ca95baa439b220ed4c8fcd30581155a1e4b7216015397714b5ebcaeec863e |
| measured_method.json | measured method parameters | 4df3db988451dc609d2e262130a6705923acf51269679a8bbfba9c8b1d160f26 |
| eval_set_measured.csv | simulated gauge readings | bd9ac6dd2f6568ee6e388c96323cba67e53adccba39ba4b67ae727cb0c870fad |

`registry_submission.json` holds the `ModelRegistry.Model` fields for every
registrable model id; it is empty because none is registrable. `metrics.json`
has one entry per model id with `maeBps`, `baselineMaeBps`,
`coverageBps`, `registrable`, both hashes and the registry payload. Inference
for both methods and the combined grader is in `kutle_health/inference.py` and
`js/infer.mjs`, tested to agree exactly on 50 inputs.

## Known limits

- Lab cell versus pack. Training and test cells are single cells cycled to
  fixed protocols. A laptop pack has three cells in series, a management system
  that keeps them inside a voltage window, partial and irregular cycles, long
  rests at high charge, and calendar ageing. None of that is in the data.
- Chemistry coverage. LCO (CALCE) and LFP (Severson) in training, NASA 18650s
  in test. Laptop packs are usually LCO or LCO/NMC blends charged to higher
  voltage. NMC, NCA, LMO and silicon-graphite anodes are not represented.
- Two training datasets are not enough for out-of-domain calibration. Leaving
  one out leaves a single dataset to fit on, and the swap test shows the two
  disagree badly. A third or fourth training dataset is the most direct fix.
- Cycle count does not transfer. NASA cells lose 20 to 30 points in under 200
  cycles; CALCE cells take 500 to 700 cycles and Severson cells 150 to 750 to
  lose 20.
- Resistance growth needs a first-use reference. A passport device can store it
  at issue; a pack read for the first time late in life has none.
- RUL60 is trained on nine CALCE cells and calibrated in-distribution, since
  only one training dataset reaches 60%. Only one held-out cell reaches it.
- On a Mac, Qmax per cell reads above design capacity because it is the
  low-rate chemical capacity. The measured method uses full charge capacity
  (AppleRawMaxCapacity), which Impedance Track derives from Qmax and
  resistance and which matches the lab discharge capacity better.

## Check against a real pack

On the demo MacBook Air (bq40z651, 3 cells, cycle 170, last Qmax update at
cycle 169, so 1 cycle old) the learned model gave 95.2% with an interval of
79.3% to 104.8% after sweeping the unknown resistance reference. The
measured-fresh method gave 94.6% with 93.5% to 95.7% (measured 94.7%). The
tamper rule does not fire, and the grader would submit modelId
kutle-soh-measured-fresh-v1, sohBps 9463, lowBps 9354, highBps 9566,
rulCycles 432, which gradeFor turns into REUSE. Because that model id is not
registrable, recordHealth would reject the submission today. The grade would
rest on the gauge's own measurement and TI's accuracy figure, not on the
learned model.

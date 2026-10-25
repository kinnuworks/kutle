# Data sources

All raw files are fetched by `data/download.py` into `data/raw/` (gitignored)
and are not redistributed in this repository. SHA-256 checksums of the
downloaded archives are recorded in `data/checksums.json` on first download and
verified on every later run. Only numeric data files are extracted; nothing
that ships with a dataset is executed.

## NASA PCoE Battery Data Set

- URL: https://phm-datasets.s3.amazonaws.com/NASA/5.+Battery+Data+Set.zip
  (mirror of the NASA Prognostics Center of Excellence data repository)
- Content: 2 Ah 18650 Li-ion cells (B0005 to B0056) cycled at 4, 24, 43 and
  44 C ambient, with charge, discharge and impedance (EIS) records.
- Used here as the held-out test dataset. The registered evaluation set is
  B0005, B0006, B0007, B0018, B0034 and B0036 (24 C ambient, first clean
  capacity reading at least 80% of rating). The other cells are reported as a
  stress set.
- Licence: published by NASA Ames Research Center as open data (a U.S.
  Government work). No restrictions on use are stated beyond citation.
- Citation: B. Saha and K. Goebel (2007). "Battery Data Set", NASA Prognostics
  Data Repository, NASA Ames Research Center, Moffett Field, CA.

## CALCE battery data (CS2 and CX2)

- URL pattern: https://web.calce.umd.edu/batteries/data/<CELL>.zip
- Cells downloaded: CS2_33 to CS2_38 (1.1 Ah LCO prismatic) and CX2_34,
  CX2_36, CX2_37, CX2_38 (1.35 Ah LCO prismatic). Arbin exports with current,
  voltage, capacity, energy and internal resistance; no cell temperature.
- Used here as training data.
- Licence: the CALCE site does not state a formal licence. It asks users to
  cite the group's publications. Check the site's terms before redistributing
  any raw files.
- Citations requested by CALCE:
  - W. He, N. Williard, M. Osterman, M. Pecht. "Prognostics of lithium-ion
    batteries based on Dempster-Shafer theory and the Bayesian Monte Carlo
    method." Journal of Power Sources 196 (2011) 10314-10321.
  - Y. Xing, E. W. M. Ma, K.-L. Tsui, M. Pecht. "An ensemble model for
    predicting the remaining useful performance of lithium-ion batteries."
    Microelectronics Reliability 53 (2013) 811-820.

## Severson et al. 2019 (Toyota Research Institute, Stanford, MIT)

- URL: https://data.matr.io/1/projects/5c48dd2bc625d700019f3204
- File used by default: batch 2017-06-30
  (https://data.matr.io/1/api/v1/file/5c86bf13fa2ede00015ddd82/download,
  about 2.0 GB, MATLAB v7.3 / HDF5). The other two batches (about 3 GB each)
  can be added with `--severson-batches`; they were left out to keep the
  download manageable. Cells 7, 8, 9, 15 and 16 of this batch continue cells
  from the 2017-05-12 batch with a restarted cycle counter and are skipped.
- Content: 1.1 Ah A123 APR18650M1A LFP/graphite cells under multi-step fast
  charging, 4C discharge, 30 C chamber. Per-cycle discharge capacity, internal
  resistance and cell temperature, plus the full voltage and current curves.
- Used here as training data.
- Licence: CC BY 4.0, as listed on data.matr.io.
- Citation: K. A. Severson, P. M. Attia, N. Jin, N. Perkins, B. Jiang, Z. Yang,
  M. H. Chen, M. Aykol, P. K. Herring, D. Fraggedakis, M. Z. Bazant,
  S. J. Harris, W. C. Chueh, R. D. Braatz. "Data-driven prediction of battery
  cycle life before capacity degradation." Nature Energy 4 (2019) 383-391.

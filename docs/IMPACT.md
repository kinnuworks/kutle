# Climate impact assessment

## How Kütle changes emissions

Kütle's effect on emissions is indirect. It removes two reasons used batteries are wasted.

1. **Buyers do not trust a used pack's health.** Second-life buyers discount packs whose history they cannot check, and many packs that could store solar energy for another decade go straight to shredding instead. A passport with signed gauge history and a grade anyone can recompute lowers that discount. Every pack moved from shredding into a second life avoids building a new battery of the same capacity.
2. **Recycled-content claims are cheap to fake.** From 2031 battery makers must meet minimum recycled shares (16% cobalt, 6% lithium, 6% nickel, 85% lead). If a recycled gram can be claimed twice, or invented, makers can meet the rule on paper while virgin mining continues. The conservation ledger makes each gram of recycled metal traceable to batteries that really were recycled, so the rule produces the demand for recycling it was written to create.

The first effect is the larger one and the one we can quantify with confidence.

## Factors used

| Factor | Value | Source |
|---|---|---|
| Emissions of new Li-ion cell production | 58 to 92 kg CO2e per kWh | Fraunhofer ISI, cradle to gate ([link](https://publica.fraunhofer.de/handle/publica/480983)) |
| Share of the manufacturing burden a second life relieves (conservative allocation) | 15% to 29% | Chalmers LCA of second-life Li-ion batteries ([link](https://odr.chalmers.se/handle/20.500.12380/304462)) |
| Capacity left when an EV pack is retired | 70% to 80% | Common retirement threshold; Kütle uses the lower bound of the measured interval |
| Hydrometallurgical nickel sulfate versus dominant primary routes | about 70% lower carbon intensity | Transport & Environment, 2026 ([link](https://www.transportenvironment.org/articles/from-mine-to-recovery-the-case-for-nickel-recycling-in-europe)) |
| Recycled lithium hydroxide versus mined | about 74% lower (vendor-sponsored LCA) | Minviro for RecycLiCo, 2022 ([link](https://metaltechnews.com/story/2022/07/20/tech-metals/lca-confirms-recyclico-co2-advantages/1013.html)) |

Two numbers are reported everywhere: gross avoided manufacturing (what building the equivalent new battery would have emitted) and the allocated share (only the 15 to 29% that an LCA credits to the second life). The allocated figure is the one to quote; the gross figure shows the ceiling.

## Per pack

A 60 kWh EV pack graded for second life with a lower interval bound of 70.5% keeps 42.3 kWh.

| | Low | High |
|---|---|---|
| Gross avoided manufacturing | 2.45 t CO2e | 3.89 t CO2e |
| Allocated to the second life | 0.37 t CO2e | 1.13 t CO2e |

These are exactly the numbers the contract books when the pack is repurposed (`PassportRegistry.Repurposed` event, `test_repurposeLinksLineageAndBooksAvoidedEmissions`). Every second life recorded through Kütle adds to running totals on chain, so anyone can audit the impact claim from the chain itself.

## Per GWh of packs moved into second life

At 75% retained capacity, 1 GWh of retired packs is 0.75 GWh of storage.

| | Low | High |
|---|---|---|
| Gross avoided manufacturing | 43,500 t CO2e | 69,000 t CO2e |
| Allocated to the second life | 6,500 t CO2e | 20,000 t CO2e |

## Türkiye scenario

| Input | Value | Status |
|---|---|---|
| Siro (Togg and Farasis) pack capacity today | 3 GWh per year | secondary source ([ReportCubes](https://www.thereportcubes.com/report-store/ev-battery-market-turkey)) |
| Siro target by 2031 | 20 GWh per year | secondary source |
| Packs reaching end of first life per year, mid 2030s | 3 GWh | ASSUMPTION: today's output, retired after about 10 years |
| Share of retired packs going to second life without trusted grading | 20% | ASSUMPTION |
| Share with Kütle-style passports and grading | 40% | ASSUMPTION |

The extra 20 percentage points move 0.6 GWh per year into second life:

| | Low | High |
|---|---|---|
| Gross avoided manufacturing per year | 26,100 t CO2e | 41,400 t CO2e |
| Allocated per year | 3,900 t CO2e | 12,000 t CO2e |

At Siro's 2031 target the same shares apply to 20 GWh, about 6.7 times these figures, once those packs retire in the 2040s. The impact page in the app lets a reader change every assumption.

## Recycled metal

For a 60 kWh NMC811 pack holding about 36 kg of nickel and 6 kg of lithium, the 2031 minimum recycled shares mean 2.2 kg of recycled nickel and 0.36 kg of recycled lithium per pack. With nickel sulfate from hydrometallurgy at about 70% lower carbon intensity than primary routes, every gram that is genuinely recycled, and not double-claimed, cuts the nickel part of the footprint by that fraction. We do not add a tonnage figure for this effect: the per-kg primary and recycled factors in the literature use different system boundaries, and we prefer no number to a misleading one. What Kütle guarantees is the precondition for any of that saving: recycled metal is counted once and only once.

## What could make these numbers wrong

- Second-life demand may be limited by storage prices, not by trust in grading. Then the share shift would be smaller than assumed.
- A second-life pack replaces a new stationary battery only if the buyer would otherwise have bought one. The allocated figure already discounts this partly.
- Turkish production and export volumes are taken from secondary market reports.
- The demo uses a laptop pack. Laptop packs are outside the passport mandate and are not in the projections.

## What is measured versus projected

Measured in the build: the grading pipeline on a real pack (this MacBook Air's battery, 164 cycles, 94.1% capacity by the gauge's own measurement), gas costs, proof sizes and the avoided-emission bookkeeping on chain. Projected: everything at fleet scale, with the assumptions marked above.

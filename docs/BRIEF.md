# Kütle: problem statement and solution overview

## The problem

From 18 February 2027, every EV, light-vehicle and industrial battery above 2 kWh sold in the EU must carry a digital battery passport (Regulation (EU) 2023/1542). From August 2028 makers must document the recycled cobalt, lithium, nickel and lead in their batteries, and from August 2031 they must meet minimum shares: 16% cobalt, 6% lithium, 6% nickel, 85% lead. Türkiye is building battery plants that export to the EU, among them Siro in Gemlik and the planned Ford, LG and Koç cell plant near Ankara.

Two failures waste batteries and the metal in them.

1. **Used packs are shredded because nobody trusts their history.** A pack that could store solar power for another decade is worth little if the buyer cannot check how it was used. A health record kept in the seller's database can be edited, and a passport must stay valid for at least ten years, longer than the companies that issue it may last and longer than today's signatures can be trusted against quantum computers.
2. **Recycled content is easy to inflate.** The same recovered kilogram can be claimed by two battery makers, or claimed without ever existing. If that happens, the 2031 rules are met on paper while mining continues.

## The solution

Kütle is a battery passport whose data cannot be quietly rewritten, plus a ledger in which recycled metal has to add up.

| Step | What happens | What makes it trustworthy |
|---|---|---|
| Signed readings | A microcontroller next to the battery's fuel gauge signs batches of readings with an Ethereum key and with ML-DSA-44, the post-quantum signature NIST standardised in 2024 | Both signatures are verified on chain; keys go through the verifier authors' registration safeguards, including a check on chain that rejects forgeable keys |
| Health grade | State of health with an uncertainty interval, from the gauge's own capacity measurement | The contract computes the grade from the interval (reuse, repurpose, bench test, recycle); only models whose held-out results beat a baseline with at least 85% coverage can be registered and cited |
| Second life | A graded pack is handed over with a new passport linked to the old one | The contract books the avoided manufacturing emissions for the retained capacity |
| Recycling | A recycler feeds packs into a batch; their passports close for good | For every metal: input = recovered + loss + unprocessed, and recovery cannot exceed what physics allows on any pass |
| Recycled content | Recovered metal becomes private notes that a maker spends into a new battery's passport | A zero-knowledge proof shows the maker owns enough recycled metal; the share is public, the suppliers stay private, and a note can be spent once |

Governance is a 2-of-3 council behind a timelock. The deployer gives up every role at deployment, and the legal thresholds and physical limits are constants in the code.

## Who uses it

Battery makers facing the 2027 passport deadline and the 2031 recycled-content minimums; second-life operators buying used packs; recyclers who want a premium for metal buyers can count toward their legal share; and market-surveillance authorities who need to check records without asking each company for its database.

## Impact

For a 60 kWh EV pack moved into second life at 70.5% retained capacity, avoided manufacturing is 2.45 to 3.89 t CO2e gross and 0.37 to 1.13 t CO2e under a conservative allocation (Fraunhofer ISI 58 to 92 kg CO2e per kWh of cells; Chalmers 15 to 29% allocation). Every GWh of packs moved into second life avoids 6,500 to 20,000 t CO2e allocated. In a Türkiye scenario where trusted grading raises the second-life share of 3 GWh of retiring packs a year from 20% to 40% (both shares are assumptions), the allocated saving is 3,900 to 12,000 t CO2e a year. Details and sources: [IMPACT.md](IMPACT.md).

## What is built

- Solidity contracts with 112 passing tests, invariant fuzzing, symbolic proofs (Halmos) and mutation testing (20 of 20 broken rules caught).
- ML-DSA-44 verified on chain from real keys and signatures, and a real UltraHonk proof verified on chain.
- ESP32-S3 firmware that builds and matches the TypeScript gateway byte for byte; the gateway anchors real readings from a MacBook battery.
- A health pipeline trained on public CALCE and Stanford/MIT data and tested once on NASA data. All three methods beat the baseline, and none yet meets our own 85% coverage rule (best: 71.6% for fresh gauge measurements), so no model is registered and a public deployment grades packs as bench test until one passes. We report every number in [model/README.md](../model/README.md).
- A Turkish and English web app with an attack console of real failing transactions.

## Why it fits COP31

COP31 in Antalya lists zero waste, green industry and clean energy among its Action Agenda themes. Kütle keeps batteries in use longer and their metal in circulation, gives Turkish exporters verifiable data for EU rules, and puts second-life packs to work storing renewable power.

Repository: https://github.com/kinnuworks/kutle

# Devpost submission text

## Tagline

Like a car's service history, but for EV batteries, and impossible to fake.

## Track

Track 3: Sustainable supply chains and circular economy. The project also covers second-life storage (Track 2) and signed sensor data (Track 4).

## Inspiration

From February 2027, every EV, light-vehicle and industrial battery sold in the EU needs a digital passport, and from 2031 battery makers must prove minimum recycled content. Türkiye is building battery plants that export to the EU, and COP31 comes to Antalya with zero waste and green industry on its agenda.

Two things stood out when we read the regulation next to how batteries are actually traded. Used packs get shredded because buyers cannot trust a seller's claim about their health. And "recycled content" is a number that is easy to inflate: the same recovered kilogram can be claimed twice, or invented. We wanted a passport whose data could not be quietly rewritten for the ten years the law requires, and a recycled-content ledger that obeys conservation of mass.

## What it does

- A microcontroller next to the battery's fuel gauge signs every batch of readings with two keys: a standard Ethereum key and ML-DSA-44, the post-quantum signature NIST standardised in 2024. The smart contract verifies both on chain. A passport must stay checkable long after the battery is recycled, past the point ECDSA can be trusted, and a forged history could pass a worn pack off as healthy.
- State of health comes from the gauge's fresh capacity measurement with its stated uncertainty, and the contract computes the grade itself from the interval: reuse, repurpose, bench test or recycle. The chain only accepts health models whose results on data they never saw beat a baseline with at least 85% interval coverage. None of our three health methods passes that rule yet on held-out NASA cells (the best, fresh gauge measurements, covers 71.6%), so no model is registered and grades stay at bench test until one does. We publish every number.
- A second-life operator takes over a graded pack with a new passport linked to the old one. The contract books the manufacturing emissions avoided for the retained capacity.
- At end of life, a recycler feeds packs into a batch. Their passports close for good, so the metal they held is the batch's input. A lab and the recycler co-sign the assay, and for every metal the contract keeps input = recovered + loss + unprocessed, with recovery capped at what physics allows on every pass.
- Recovered metal becomes private notes. A battery maker proves with a zero-knowledge proof, generated in the browser, that it owns enough recycled metal to back a new battery. The recycled share is public, as the law requires. Which recycler supplied it stays private.
- An attack console sends real transactions that try to cheat each rule and shows why each one fails.

## How we built it

- Solidity contracts (Foundry), with the ML-DSA-44 verifier from Fireblocks Labs and the registration safeguards from its safety report: a degeneracy check on the key itself, de-duplication on the canonical key, code-hash pinning of every external call, and proof of possession with both keys.
- A Noir circuit proved with UltraHonk (Barretenberg); Poseidon2 matched byte for byte between Noir and the EVM.
- ESP32-S3 firmware in C with mldsa-native and libsecp256k1, plus a TypeScript gateway that reads this MacBook's battery gauge through ioreg. Shared test vectors keep the C and TypeScript encodings identical.
- A gradient-boosted health model with conformal intervals calibrated across datasets, trained on public CALCE and Stanford/MIT cell data and tested once on NASA data it never saw, exported to JSON with matching Python and JavaScript inference.
- A React app in Turkish and English.
- Governance by a 2-of-3 council behind a timelock; the deployer gives up every role at deploy time.

## Challenges we ran into

- ML-DSA keys can be degenerate in a way that lets anyone forge signatures without the secret, and proof of possession does not catch it. We had to apply the verifier authors' registration rules exactly, including a check that runs on chain over all 1,024 coefficients of the key.
- One ML-DSA verification costs about 1.2M gas, so the device signs a Merkle root over many readings, and any single reading can be proven later.
- Recycled-content ledgers we studied capped output at input. That cap can be beaten by parking metal as "unprocessed" and claiming it later at 100%. We moved to an exact equality with a ceiling on each pass, proved the single-pass rule symbolically, and check multi-pass sequences with invariant fuzzing.
- The Poseidon2 contract compiled above the EVM's contract size limit under our optimizer settings, so we use its canonical deployment and checked its outputs against the circuit's test vectors.

## Accomplishments that we're proud of

- Post-quantum signatures verified on chain, end to end, from a real battery gauge.
- 112 passing contract tests including invariant fuzzing, symbolic proofs with Halmos, and mutation testing in which all 20 deliberately broken rules make the suite fail.
- A private recycled-content proof generated in the browser in about a second.
- An on-chain model registry strict enough to refuse all three of our own health methods. We report every number.
- Every required document, including the security assessment and the climate impact assessment with sourced numbers.

## What we learned

The hard part of "blockchain for supply chains" is the oracle, not the chain. Every rule in Kütle is designed around who could lie, and what they would gain: a recycler cannot invent metal because its input is fixed by passports it cannot reopen, and a grader cannot pick a grade because the contract computes it.

## What's next

- Aggregate many device signatures into one succinct proof to cut cost per batch.
- Prove the health model's inference in zero knowledge, bound to the signed readings.
- Pilot with a Turkish pack assembler, a second-life operator and a recycler, and export passports to the EU registry format.

## Built with

solidity, foundry, halmos, noir, barretenberg, ultrahonk, ml-dsa, fips-204, poseidon2, eip-712, openzeppelin, base, viem, typescript, react, vite, esp32-s3, platformio, c, mldsa-native, libsecp256k1, python, scikit-learn, conformal-prediction

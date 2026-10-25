# Kütle

A battery passport where recycled metal has to add up.

IEEE ClimateChain Global Hackathon 2026 · Track 3, Sustainable supply chains and circular economy (also touches Track 2, second-life storage, and Track 4, signed sensor data).

From 18 February 2027 every EV, light-vehicle and industrial battery sold in the EU needs a digital passport (Regulation (EU) 2023/1542). From 2031 battery makers must also meet minimum shares of recycled cobalt, lithium, nickel and lead. Kütle issues the passport, keeps the battery's health history honest for the ten-plus years a passport must survive, decides whether a used pack should get a second life or go to recycling, and runs a ledger in which no gram of recycled metal can be counted twice or created out of nothing.

*Kütle* is Turkish for mass.

## Judge path, 90 seconds

1. Open the app (link below) and press **Follow one battery**. It walks one real pack, the battery in the laptop this was built on, from signed gauge readings to a grade, a second life and recycling.
2. Press **Try to cheat it**. Each card sends a real transaction that fails, with the contract's reason shown.
3. Open [docs/SECURITY.md](docs/SECURITY.md) section 2 for what the system trusts and how each assumption is enforced.

## What is in the box

| Part | What it does | Status |
|---|---|---|
| Device signing | An ESP32-S3 next to the battery's fuel gauge signs every batch of readings with secp256k1 and ML-DSA-44 (FIPS 204). Both signatures are verified on chain | Firmware builds; host tests match the TypeScript gateway byte for byte; the laptop gateway anchors real readings from this MacBook's battery |
| On-chain ML-DSA | Real post-quantum signature checks in Solidity, with the key-registration safeguards the verifier's safety report requires (degeneracy floor on chain, key de-duplication, code-hash pinning, proof of possession) | Tested with real keys and signatures |
| Health model | State of health with a conformal prediction interval and remaining cycles, trained on public cell-ageing data and tested on a dataset it never saw against a linear-fade baseline | See [model/README.md](model/README.md) |
| Passports | On-chain core of the Battery Pass record (DIN DKE SPEC 99100): metal content, recycled content, health grades, lineage, revocation | Grade computed on chain from the interval |
| Conservation ledger | For every metal of every recycler batch: input = recovered + loss + unprocessed, recovery capped per pass, input fixed by closed passports, co-signed EIP-712 assays | Unit tests, invariant fuzzing, symbolic proofs |
| Private recycled content | Recovered metal becomes notes in a Poseidon2 tree; a maker proves in zero knowledge (Noir, UltraHonk) that it owns enough to back a new battery. The share is public; the suppliers are not | Real proof verified on chain in the tests |
| Governance | 2-of-3 council behind a timelock; the deployer renounces every role at deploy time | Tested |
| App | Passport viewer, verifier, recycler and maker consoles, attack console, impact page, Turkish and English | See [app/README.md](app/README.md) |

## Why each cryptographic piece is there

- **ML-DSA on every reading batch:** a passport must stay checkable for years after the battery is recycled, longer than ECDSA can be trusted. A forged health history could pass a worn pack off as healthy.
- **Merkle roots:** one ML-DSA verification costs about 1.2M gas, so the device signs a root over many readings, and any single reading can be proven later.
- **The ledger:** four parties with opposed interests (maker, second-life operator, recycler, next maker) touch the same battery, and the record must outlive all of them.
- **Zero knowledge:** the law makes the recycled share public. Makers treat their recycler relationships as trade secrets. The proof gives both.

## Numbers

| | |
|---|---|
| Contract tests | 112 passing (unit, fuzz, invariant, real ML-DSA and UltraHonk proofs) |
| Symbolic proofs | Conservation for every input, grading soundness and monotonicity (Halmos) |
| Mutation testing | 20 of 20 deliberately broken rules caught by the suite |
| Gas | device registration 2.73M, reading batch 2.47M, note mint 0.88M, private spend 4.84M |
| Proof | 13,384 UltraHonk gates, about 230 ms in the browser, 8 KB |
| Signatures | ML-DSA-44: 1,312-byte public key, 2,420-byte signature |

## Documents

| Required deliverable | File |
|---|---|
| Problem statement and solution overview (2 pages) | [docs/BRIEF.md](docs/BRIEF.md) |
| Architecture diagram and technical specification | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Security and data-integrity assessment | [docs/SECURITY.md](docs/SECURITY.md) |
| Climate impact assessment and carbon reduction projections | [docs/IMPACT.md](docs/IMPACT.md) |
| Implementation and adoption strategy | [docs/ADOPTION.md](docs/ADOPTION.md) |
| Scalability and sustainability roadmap | [docs/ROADMAP.md](docs/ROADMAP.md) |
| User testing results | [docs/USER_TESTING.md](docs/USER_TESTING.md) |
| 3-minute video | link below |

## Run it

```bash
git clone --recursive <repo-url> && cd kutle
```

Contracts (Foundry):

```bash
cd contracts && forge test
```

Symbolic proofs (Halmos):

```bash
cd contracts && halmos --contract SymbolicTest
```

Circuit (Noir 1.0.0-beta.22):

```bash
cd circuits/shielded_spend && nargo test
```

Device gateway and provisioning:

```bash
cd device && pnpm install && node --test gateway/test/
```

Firmware host tests:

```bash
cd device/firmware && pio test -e native
```

Model:

```bash
cd model && python -m pytest -q
```

App on a local chain with a seeded demo story:

```bash
cd app && pnpm install && pnpm dev:chain
```

## What is real and what is simulated

Real: ML-DSA-44 and ECDSA signatures checked on chain, the UltraHonk proof checked on chain, the laptop battery's gauge readings, the health model's evaluation on public data, all contract rules. Simulated: the testnet role keys, the lab's accreditation reference, the recycler batches and assay numbers in the demo. The demo battery is a laptop pack, which the passport mandate does not cover; the pipeline is the one an EV or industrial pack would use. Full list in [docs/SECURITY.md](docs/SECURITY.md) section 4.

## Credits

Built on open work by others: the ML-DSA-44 verifier by Fireblocks Labs (MIT), Poseidon2 for the EVM by zemse (MIT), mldsa-native from the PQ Code Package, bitcoin-core/secp256k1, Noir and Barretenberg by Aztec, OpenZeppelin Contracts, Foundry, Halmos by a16z, and the Battery Pass data model by the Battery Pass consortium. Cell-ageing data from NASA, CALCE and Severson et al. (see [model/data/SOURCES.md](model/data/SOURCES.md)).

## License

MIT

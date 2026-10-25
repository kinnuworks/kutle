# Scalability and sustainability roadmap

## Scale today

| Resource | Today | Limit and plan |
|---|---|---|
| Reading batches | One ML-DSA-44 verification per batch (about 2.5M gas); any number of readings per batch | A device batching hourly writes 24 transactions a day. For fleets, batches from many devices can be aggregated into one proof later (see below) |
| Note tree | Depth 16, 65,536 notes | Raise depth with a new pool, or rotate pools per year; nullifiers stay unique per pool |
| Passports | No practical limit; one storage record each | Archive data is off chain; only hashes and numbers that rules depend on are on chain |
| Proof generation | About 230 ms in the browser for a spend | Fine for a maker's back office; no server-side prover needed |
| Fees | Base Sepolia today; Base or another proof-of-stake L2 in production | Contracts are chain-agnostic EVM code |

## Next twelve months

1. **Aggregate device signatures.** Verify many ML-DSA signatures off chain inside one succinct proof and post a single proof per block of batches, cutting per-batch cost by an order of magnitude.
2. **Prove inference.** Run the health model inside a zkML circuit that takes the anchored readings as input, so a grade is proven to come from that model and those readings.
3. **On-chain key blob derivation.** Derive the verifier blob from the 1,312-byte key on chain once per key, removing the last off-chain registrar assumption.
4. **Secure element on the device.** Move keys into a secure element and add firmware attestation.
5. **EU registry export.** Map every passport to the EN 18216 to 18223 exchange formats and push to the EU registry with the on-chain hash as the integrity anchor.
6. **More recycled-content rules.** Track the final recycled-content calculation method once the Commission adopts the delegated act (the draft was open for feedback in August and September 2026), and update the ledger rules through governance.

## Sustainability of the system itself

- **Energy.** Proof-of-stake chain; heavy data off chain. Verifying one ML-DSA signature costs about as much computation as a token swap.
- **Governance.** A council of independent members behind a timelock. Physical ceilings, legal thresholds and grading rules are constants, so changing them requires a new, visible deployment.
- **Funding.** Per-passport fees paid by manufacturers cover devices and operations. Recyclers pay a small fee per issued note, recovered from the premium recycled metal earns.
- **Longevity.** The passport record does not depend on any single company. If Kütle as an organisation disappeared, the contracts, the public data and the open-source verifier would keep every passport checkable.
- **Open standards.** Battery Pass data model, GS1 Digital Link, FIPS 204, EIP-712, Noir and UltraHonk are all public specifications.

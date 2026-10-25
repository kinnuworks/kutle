# Security and data-integrity assessment

This document covers what Kütle protects, who it trusts, how each trust assumption is enforced or limited, and what is simulated in the hackathon build. It is written for a reviewer who wants to know where the system can be fooled.

## 1. What must stay true

| Property | Where it is enforced |
|---|---|
| A health record on a passport comes from the battery's own gauge, unaltered | `DeviceRegistry`, `ReadingLog` (hybrid signatures, sequence numbers, time windows, Merkle roots) |
| A grade follows from the data and a registered model, not from the grader's opinion | `PassportRegistry.recordHealth` and `gradeFor`, `ModelRegistry` |
| Recycled metal cannot be created from nothing | `ConservationLedger` (input fixed by closed passports, exact balance, physical ceiling per pass) |
| A battery can feed only one recycler batch | `PassportRegistry.closeAtRecycler` (one-way status change) |
| Each gram of recycled metal backs at most one new battery | `NotePool` (nullifiers, zero-knowledge spend proof) |
| A battery maker's suppliers and volumes stay private | `NotePool` (only nullifiers, the passport and the declared grams are public) |
| Records stay checkable for at least ten years | ML-DSA-44 (FIPS 204) on every device signature, verified on chain |
| No single key can change the rules | `KutleCouncil` (2 of 3) behind a `TimelockController`; legal and physical limits are compile-time constants |

## 2. Trust assumptions, one by one

### 2.1 Device keys

Each battery-side device holds a secp256k1 key and an ML-DSA-44 key. A reading batch is accepted only if both sign the same digest, which binds the chain id, the `ReadingLog` address, the device, the passport, a sequence number, the Merkle root and the time window.

Why both: a passport must stay verifiable for years after the battery is recycled, past the point where ECDSA can be trusted against a quantum adversary. A forged history could pass a worn pack off as healthy and move it into second life. ECDSA stays as a hedge against an implementation flaw in the newer scheme. An attacker must break both.

The ML-DSA signature is verified on chain, using the MIT-licensed FIPS 204 verifier by Fireblocks Labs (`lib/evm-ml-dsa-verifier`, about 1.23M gas per check). Measured costs in this repo: device registration 2.73M gas, one batch anchor 2.47M gas.

The verifier's own safety report (section 3.1) lists what a registrar must do, because a degenerate ML-DSA key can be forged with no secret at all, and a proof of possession does not catch it. Kütle's handling:

| Requirement from the verifier's safety report | Kütle |
|---|---|
| Key exactly 1,312 bytes, checked before hashing | `MLDSAKey.largeLiftCount` reverts on any other length |
| Reject degenerate keys by a criterion on the key itself | `MLDSAKey.requireNonDegenerate`: centred-lift floor, at least 512 of 1,024 t1 coefficients must have a large lift; runs on chain at registration |
| Bind the key to its KeyGen seed (the complete criterion) | The provisioning station re-derives the public key from the device's seed and requires a byte-for-byte match (device/provision). This is off chain, during the key ceremony |
| De-duplicate on the canonical key, never on the blob | `pkHashUsed[keccak256(pk)]` |
| Bind the blob by code hash and re-check at every use | `pkBlobCodehash` stored at registration, compared before every verification |
| Pin every external call target by code hash | The ML-DSA verifier and the Poseidon2 contract are pinned; a swapped implementation makes calls revert (`VerifierSwapped`, `CodeSwapped`) |
| Proof of possession, in addition to the above | Both keys sign `popDigest` at registration |

Residual risk: the on-chain check cannot prove that the 20,545-byte blob is exactly `prepare(pk)`. The registrar checks this off chain. A wrong blob makes valid signatures fail; it cannot make an invalid signature pass for a key the blob does not encode, and the proof of possession runs against the blob itself. We state the assumption rather than hide it.

Key rotation keeps the old version on record so batches it signed stay attributable. Revocation by the authority takes effect immediately. Signature suites are pluggable (`setSuite`), so ML-DSA-65 or another scheme can be added later without invalidating older records.

### 2.2 The gauge itself

A signature proves which device signed, not that the physics is right. A tampered gauge could report a higher capacity. Mitigations: the signing key lives on a separate microcontroller next to the gauge, readings are sampled continuously so a sudden capacity jump is visible in the history, and the health model flags out-of-distribution inputs. Production hardware should keep keys in a secure element with flash encryption. In this build the ESP32-S3 stores seeds in NVS without flash encryption, and the laptop demo can run the signer in gateway mode, which is labeled as such everywhere it appears.

### 2.3 The health model and the grader

The grader role submits an estimate (state of health with a prediction interval, remaining cycles). The contract does not take the grader's word for the grade:

- the estimate must cite an anchored reading batch from this passport's own device;
- the model must be registered and active, and `ModelRegistry` refuses a model whose held-out error does not beat its stated baseline or whose interval coverage is under 85%;
- the grade is computed on chain from the interval (`gradeFor`), and an interval wider than 10 points can only produce "bench test".

Residual risk: a grader could submit numbers its model did not produce. Every grade names the model by id, the weights are published by hash, and the reading batch is on chain, so anyone can re-run the model and compare. Moving inference into a zkML proof is on the roadmap. We kept it out of this build because it would prove that a model ran, not that its inputs were honest, and the inputs are already signed by the device.

### 2.3a A rule that caught our own model

The model registry's rule (held-out error must beat the baseline, interval coverage at least 85%) was written into `ModelRegistry.sol` before any model was trained. When we evaluated the learned health model once on a dataset it never saw (NASA cells, trained on CALCE and Stanford/MIT cells), its interval coverage was 13% to 59%, far under the floor. The registry would refuse it, and we kept the rule. Grades now come from the gauge's own fresh capacity measurement with its stated uncertainty (about 40 bps error and 95% coverage on fresh readings), and stale readings can only produce "bench test". The learned model is used for remaining-life estimates and as an upper-bound tamper check, which raised no false alarms on honest held-out data. The full numbers, including the failed ones, are in `model/artifacts/metrics.json`. This is the oracle problem in miniature: a confident-looking estimator that would have over-claimed, stopped by a rule fixed in advance.

### 2.4 Recyclers and labs (the ledger's oracle)

This is where most "recycled content" systems are weakest, because someone has to say how much metal came out.

1. Input is not declared by the recycler. It is the sum of the metal content of the passports closed at intake, and a closed passport can never be reopened or fed into another batch.
2. Every assay must be signed by the recycler and by a lab the council accredited. Both sign one EIP-712 digest that includes the batch, the assay's sequence number and a deadline, so an assay cannot be replayed within a batch, across batches, or after it expires. Recyclers may sign with a multisig (ERC-1271).
3. For every element, `input = recovered + loss + unprocessed` exactly, and on every pass `recovered ≤ processed × ceiling`, with ceilings fixed in code (99% for cobalt, nickel and lead, 98% for lithium).
4. Recovery below the legal targets of Annex XII is recorded in the event log, not rejected: the regulation sanctions the recycler, it does not void the metal.

What this rules out, with tests:

| Attack | Result |
|---|---|
| Claim more metal than the batteries held | Books cannot balance (`Unbalanced`) |
| Claim 100% recovery with both signatures | `OverCeiling` |
| Park metal as "unprocessed", then claim it later at 100% | `OverCeiling` on the second pass; unit test, and the invariant run checks it across random sequences of assays |
| Feed the same battery into a second batch | `NotActive` |
| Replay or reuse an assay | `WrongNonce` |
| Assay signed by an unaccredited lab or the wrong key | `LabNotAccredited`, `BadLabSignature` |
| Dilute with virgin material to inflate a share | Not possible: input comes from passports, and the share on a new passport is computed from its own declared composition |

Residual risk: a recycler and an accredited lab who collude can under-report recovery and divert metal off the books. That diverts metal; it cannot create recycled metal that did not exist, which is the property the recycled-content rules depend on. Under-reported recovery also shows up as "below target" against the legal minimums.

### 2.5 Revocation

A market-surveillance authority can revoke a passport. Revocation cascades down the lineage to any second-life passports, stops new readings from being accepted, and taints the recycler batch the battery fed, which blocks further assays and note issuance from that batch. Notes already issued before the revocation remain spendable; the event log identifies the batch, and the council can withdraw the recycler's role. We document this limit instead of freezing notes, because freezing would require revealing which notes came from which batch, which defeats the privacy layer.

### 2.6 The private spend

A maker proves in zero knowledge (Noir circuit, UltraHonk proof, about 13,400 gates) that it owns unspent notes of the right element in the pool's Merkle tree worth at least the declared grams. Public inputs are the root, the element, the passport, the declared grams, one nullifier per input note, the change note's leaf and a binding value derived from the chain id and the pool's address.

| Attack | Result |
|---|---|
| Spend a note twice | Nullifier already spent |
| Use one note twice in the same proof | `DuplicateNullifier` |
| Change any public input after proving (one gram more, another passport, another root) | Proof fails |
| Replay a proof on another deployment | The binding value differs |
| Back more metal than the battery contains | `ExceedsComposition` in the passport registry |
| Front-run a spend | Only the passport's operator may submit it |

Leaves are computed by the contract from public mint data (`Poseidon2(element, grams, ownerCommit)`), so a recycler cannot hide extra grams inside a commitment. The Noir Poseidon2 was cross-checked against the on-chain Poseidon2 with shared test vectors. A spend costs about 4.84M gas, most of it proof verification.

What is public: that a passport received N grams of recycled cobalt, and that some notes were spent. What is private: which recycler and which lot the metal came from, and how a maker splits purchases across batteries.

### 2.7 Governance

All admin roles sit with a `TimelockController` whose only proposer and executor is a 2-of-3 `KutleCouncil`. The deploy script grants the timelock admin and renounces the deployer's role on every contract, then checks that the deployer holds nothing. Constants that matter (recovery ceilings, legal targets, recycled-content minimums, grading thresholds, emission factors) are compile-time constants, so not even the council can loosen them without deploying new contracts.

## 3. Verification done

| Method | Scope | Result |
|---|---|---|
| Unit tests (Foundry) | Every contract, every revert path listed above, with real ML-DSA-44 keys and signatures and a real UltraHonk proof | All passing |
| Invariant fuzzing | Random feeding, honest and dishonest assays, issuance and revocation; 256 runs x 64 calls | Mass conservation, ceiling, issuance accounting, single intake and taint freeze all hold |
| Symbolic proofs (Halmos) | Single-assay conservation and ceiling for every input; grading rule soundness and monotonicity | Proven. The multi-pass properties (two passes, and the induction step for any number) time out in the solver at 64-bit width, so they are covered by invariant fuzzing for now |
| Mutation testing | 20 hand-written mutants, each removing or loosening one rule (balance, ceiling, nonce, lab, signatures, taint, nullifiers, binding, ML-DSA result, degeneracy floor, sequence, device binding); `contracts/mutation/run.py` | 20 of 20 killed: every broken rule makes the suite fail |
| Cross-implementation vectors | Poseidon2 (Noir vs EVM), ML-DSA blob builder (JavaScript vs the verifier), reading leaves and Merkle roots (TypeScript vs C) | Matching |
| Static analysis | `forge lint` findings reviewed; calls in loops go only to fixed, code-hash-pinned contracts | Reviewed |

## 4. What is simulated in the hackathon build

- The testnet deployment uses testnet demo keys for every role. The council members are demo keys.
- The lab accreditation reference is a placeholder hash.
- Recycler batches in the demo are seeded; the assay numbers are illustrative.
- The demo battery is a laptop pack (category "demo"). Portable batteries are outside the passport mandate; the pipeline is the same one an EV or industrial pack would use.
- Without the ESP32-S3 attached, the laptop can sign in gateway mode, and the interface says when it does.

## 5. Not covered and planned

- zkML for the health model, binding inference to the signed readings.
- Secure-element key storage on the device and remote attestation of firmware.
- An on-chain proof that a key blob equals `prepare(pk)`, by performing ExpandA on chain once per key.
- An external audit. All reviews so far are our own.

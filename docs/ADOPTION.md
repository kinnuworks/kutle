# Implementation and adoption strategy

## Who pays, and why now

| Party | What they need | Deadline | What Kütle gives them |
|---|---|---|---|
| Battery and EV makers exporting to the EU (Siro in Gemlik, the planned Ford, LG and Koç cell plant near Ankara, pack assemblers) | A digital passport for every EV, light-vehicle and industrial battery over 2 kWh placed on the EU market | 18 February 2027 | Passports that follow the Battery Pass data model, with a QR identifier, role-based access and an on-chain core that outlives the issuer |
| The same makers | Documented recycled content, then minimum shares | August 2028 (documentation), August 2031 (minimums) | Recycled content backed gram for gram by assayed metal, provable without revealing suppliers |
| Second-life operators (stationary storage, telecom backup, light vehicles) | Confidence that a used pack is what the seller says | Now | Signed gauge history, a grade anyone can recompute, and a linked child passport as Art. 77(6) requires |
| Recyclers | A premium for recycled metal that buyers can count toward their legal share | 2028 onward | Notes that a maker can spend into a passport, and an on-chain record that the metal came from real batteries |
| Market surveillance authorities | Spot checks without asking each company for its database | 2027 onward | Read access to every passport, revocation that cascades, and a ledger that cannot be rewritten |

## Dated milestones for Türkiye

| Date | Milestone |
|---|---|
| November 2026 | Present at COP31 in Antalya; open the repository and testnet deployment to Turkish battery exporters |
| Q1 2027 | Pilot targets: one pack assembler, one second-life operator and one recycler in the Marmara region, approached through the Istanbul Chamber of Commerce. None has committed yet |
| 18 February 2027 | EU passport mandate starts; pilot passports issued for EU-bound packs |
| August 2028 | Recycled-content documentation duty; ledger in use for documented shares |
| August 2031 | Recycled-content minimums apply |

## Rollout

1. **Pilot with one pack line (months 0 to 6).** One battery assembler, one second-life operator and one recycler in the Marmara region. Devices fitted at end of line, passports issued at shipping. Success measure: share of retired packs graded and routed without manual testing.
2. **Recycler integration (months 6 to 12).** Lab assay reports signed at source by an ISO/IEC 17025 lab; the recycler's ERP posts assays through an ERC-1271 multisig. Success measure: recycled metal issued as notes and bought by one cell maker.
3. **EU registry connection (2027).** Export each passport's record to the EU digital product passport registry format (EN 18216 to 18223 exchange standards) with the on-chain hash as the integrity anchor.
4. **Second chemistry and categories.** LFP for stationary storage, light-vehicle batteries for scooters and e-bikes, using the same contracts.

## Integration cost for a manufacturer

| Item | Cost driver | Notes |
|---|---|---|
| Edge device | ESP32-S3 class microcontroller next to the gauge | A few euros of hardware per pack at volume. Large packs already carry a BMS microcontroller that can run the same firmware |
| Provisioning station | One per production line | Generates and checks keys during end-of-line test |
| On-chain fees | About 2.5M gas per signed batch, 4.8M per private spend | On an L2 such as Base, a few cents or less per transaction at recent prices. Batches can cover a day of readings |
| Integration | MES/ERP to issue passports and post compositions | REST and event interfaces in the gateway; the passport JSON follows the Battery Pass schema |

## Who could object, and the answer

- **"We do not want our suppliers visible."** They are not. The note pool hides which recycler and which lot backed a battery; only the share is public, as the law requires.
- **"We already have a passport vendor."** Kütle's contracts can sit under any vendor's front end. The on-chain core is what makes the record outlive the vendor.
- **"Blockchain fees and energy."** The chain is proof-of-stake, and the heavy data (readings, full passport JSON) stays off chain with only roots and hashes on chain.
- **"Post-quantum is premature."** A passport issued in 2027 must stay checkable into the late 2030s, after the battery is recycled. NIST finalised ML-DSA in 2024 so that records like this can be signed for that horizon today.

## Fit with COP31 and Türkiye's programmes

The Action Agenda for COP31 in Antalya lists zero waste, green industry and clean energy among its themes. Kütle serves all three: batteries stay in use longer and their metal is recovered (zero waste), Turkish exporters meet EU rules with verifiable data (green industry), and second-life packs store solar and wind power (clean energy). Türkiye's Climate Law No. 7552 and its emissions trading system point the same direction: data that regulators and buyers can check, generated where the emissions and materials are.

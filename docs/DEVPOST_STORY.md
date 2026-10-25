## The problem

Would you buy a used EV battery if you couldn't check its history? Most buyers won't. So batteries that could store solar power for another ten years get shredded, and building new storage of the same capacity emits 2.5 to 3.9 tonnes of CO2 for a typical used EV pack. Recycling has its own problem: the same kilogram of recycled cobalt can be claimed twice on paper.

## What Kütle does

- A small chip next to the battery signs its health readings, and the record goes on a blockchain with a signature that even future quantum computers can't forge. Nobody can quietly edit a battery's history.
- Anyone can check the battery's grade: reuse, second life, test, or recycle. The contract computes the grade from the data, so the seller can't pick it.
- When a pack gets a second life, the contract records the emissions that were avoided.
- When batteries are recycled, the ledger only accepts recycled metal that really came out of batteries that went in. The same kilogram can't be counted twice.
- Battery makers can prove they used enough recycled metal without revealing who sold it to them.

## Try to cheat it

The app has an attack console. Every way we found to cheat (claim more metal than the batteries held, reuse a lab report, sign a reading with a stolen key) is sent as a real transaction, and each one is refused with the reason shown.

## Why now, and why Türkiye

From February 2027 every EV battery sold in the EU needs a digital passport, and from 2031 makers must use minimum amounts of recycled metal. Türkiye's new battery plants export to the EU, and COP31 comes to Antalya with zero waste on its agenda.

## How we built it

- Solidity smart contracts that check post-quantum signatures (ML-DSA, standardised by NIST in 2024) on chain
- ESP32 firmware and a gateway that reads the real battery in our laptop
- Zero-knowledge proofs (Noir) for private recycled content
- A Turkish and English web app
- 112 tests, symbolic proofs, and a test that plants 20 bugs in our rules and catches every one

## What we learned

Our own rules caught us. The registry that decides which health models may grade batteries refused all three of ours, because on data they had never seen their error ranges were too wide. We kept the rule and published the numbers.

## What's next

A pilot with a Turkish battery assembler, a second-life solar storage operator and a recycler.

Code and every document: https://github.com/kinnuworks/kutle

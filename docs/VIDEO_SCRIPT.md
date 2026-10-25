# Demo video script (3:00)

One battery, one story. Narrated in English by the builder. Screen recording of the app on Base Sepolia, plus two short shots of the hardware. Every on-screen number is live.

| Time | Picture | Narration |
|---|---|---|
| 0:00 to 0:15 | Close-up of the laptop, then the ESP32-S3 on its cable | "Would you buy a used EV battery if you could not check its history? Most buyers will not, so good packs get shredded. This is the battery in my laptop: 164 cycles, 94 percent capacity left. Kütle is like a car's service history for batteries, and nobody can fake it. From 2027 the EU requires a passport like this for every EV battery." |
| 0:15 to 0:40 | Live device panel: readings arriving, a batch anchored, the transaction on the explorer | "Every few minutes this microcontroller signs a batch of gauge readings twice: once with a standard Ethereum key, once with ML-DSA, the post-quantum signature NIST standardised in 2024. Both are checked on chain. Why post-quantum? A passport has to stay trustworthy for ten years after the battery is recycled. A forged history could pass a worn pack off as a healthy one." |
| 0:40 to 1:05 | Passport page: health history, model card, grade | "A health model trained on public cell-ageing data estimates state of health with an interval. The chain only accepts models that beat a simple baseline on data they never saw, and it computes the grade itself from the interval. This pack: reuse. Click any reading and the app proves on chain that it is one the device signed." |
| 1:05 to 1:30 | Second-life handoff, then the impact counter | "When a pack's grade allows it, a second-life operator takes it over with a new passport linked to the old one. The contract books what that avoids: building a new battery of the same capacity. For a typical 60 kilowatt-hour EV pack, between 0.4 and 1.1 tonnes of CO2, using a conservative allocation." |
| 1:30 to 2:05 | Recycler console: batch input, co-signed assay, the equality per element | "At end of life, a recycler feeds packs into a batch. Their passports close for good, so the metal they held becomes the batch's input. A lab and the recycler co-sign the assay, and the contract holds an equality for every metal: input equals recovered plus loss plus unprocessed, with recovery capped at what physics allows. Recycled metal cannot appear from nothing, and no battery can be counted twice." |
| 2:05 to 2:30 | Attack console: three cards fail with decoded errors | "We tried to cheat it. Claim more cobalt than the batteries held: rejected. Claim 100 percent recovery with both signatures: rejected. Sign a reading with a stolen Ethereum key but no post-quantum key: rejected. These are real failed transactions." |
| 2:30 to 2:50 | Maker console: proof generated in the browser, recycled share updates | "A battery maker spends recycled metal into a new passport with a zero-knowledge proof generated right here in the browser. The law wants the recycled share public. It does not want suppliers public, and now they are not." |
| 2:50 to 3:00 | Title card: Kütle, repo link, track | "Kütle means mass in Turkish. A battery passport where recycled metal has to add up. Built for Türkiye's battery exporters, ahead of COP31 in Antalya." |

## Recording notes

- Record at 1920x1080, browser zoom 110%, dark-on-light theme.
- Pre-seed the testnet so every screen has data; record the anchor and attack transactions live.
- Keep the explorer tab ready for the 0:15 to 0:40 segment.
- Total narration is about 410 words, about 137 words per minute. Read it once aloud with a timer before recording.
- Captions: burn in English captions; add a Turkish caption track on YouTube.

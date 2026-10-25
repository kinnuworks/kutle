# Kütle web app

The browser side of Kütle: the battery passport, an independent verifier, the recycler and maker consoles, the attack console, the impact calculator and the live device panel. Every page reads the contracts directly with viem. There is no backend; `pnpm build` produces static files that can be hosted anywhere.

Interface languages: English and Turkish (toggle in the navigation bar).

## Run it locally

Requirements: Node 22 or newer, pnpm, Foundry (`~/.foundry/bin/anvil` and `forge`).

```sh
pnpm install
node scripts/dev-chain.mjs      # builds contracts, starts anvil, deploys, seeds the story, keeps the device reporting
pnpm dev                        # http://localhost:5173
```

`dev-chain.mjs` options: `--port 8545` (anvil port), `--no-build` (reuse `contracts/out-app`), `--no-live` (no new reading batch every interval), `--interval 30` (seconds between live batches).

The script builds with `FOUNDRY_OUT=out-app FOUNDRY_CACHE_PATH=cache-app` so it never touches `contracts/out`, deploys with `contracts/script/Deploy.s.sol` using anvil's default accounts for every role, and writes:

- `src/config/deployments/31337.json` (copied from `contracts/deployments/`)
- `public/demo/31337.json`: ids of the seeded passports, batches and transactions the pages use
- `public/demo/31337-readings.json`: the off-chain reading records behind each anchored Merkle root
- `.env.development.local`: RPC URL and the testnet demo keys for the consoles

## What the seed puts on chain

All signatures and proofs are real; the reading values and assay figures are generated demo data.

1. Device A registered with its ML-DSA-44 and ECDSA keys (the same keys as `contracts/test/fixtures/mldsa.json` key A1, re-signed for the deployed registry).
2. Passport #1 for a 60 kWh NMC811 EV pack; three signed reading batches and three health grades over a year.
3. A model registered through the council (2 of 3) and the timelock.
4. Two worn packs graded for recycling, closed into recycler batch 1, an assay co-signed by the recycler and an accredited lab, and recycled-metal notes issued to the demo maker.
5. Passport #1 repurposed into a child passport for stationary storage; the same device keeps anchoring batches for it.
6. A new battery whose cobalt and lithium are backed by notes, spent with real UltraHonk proofs.
7. State the attack console needs: a batch with unprocessed metal and no assay, a revoked device key, a held-back proof, and an approved council proposal that registers a model worse than its baseline.

## Pages

| Route | What it does |
|---|---|
| `/` | The story of one battery with live data, the 90-second path, an embedded attack, the impact calculator |
| `/p/:id` | Passport with audience views (public, legitimate interest, authority), recycled share against the 2031 and 2036 minimums, health history, lineage, QR code, and live `ReadingLog.verifyReading` of any reading |
| `/01/:gtin/21/:serial` | GS1 Digital Link resolver; the QR codes point here |
| `/verify/:id` | Every check re-run in the browser, each with the calls it made |
| `/recycler` | Open a batch, intake passports, build and co-sign an assay (EIP-712), settle, issue notes |
| `/maker` | Pick notes, prove the spend in the browser with bb.js, submit `NotePool.spend` |
| `/attacks` | Twelve real transactions that must fail, decoded with the contract ABIs |
| `/impact` | On-chain avoided-emission totals and a sourced calculator with a Türkiye scenario |
| `/device` | Latest batches of the demo device, refreshed every five seconds |

## Configuration

| Variable | Meaning |
|---|---|
| `VITE_CHAIN_ID` | chain to read, default 31337; the deployment comes from `src/config/deployments/<chainId>.json` |
| `VITE_RPC_URL` | RPC endpoint, default `http://127.0.0.1:8545` |
| `VITE_FROM_BLOCK` | first block to scan for events on a public network |
| `VITE_DEMO_KEY_<ROLE>` | testnet demo keys for the consoles; without them the consoles are read only |
| `VITE_DEMO_MAKER_SECRET` | note owner secret of the demo maker |
| `VITE_APP_URL` | public URL used in QR codes |

A production build (`pnpm build`) does not load `.env.development.local`, so it is read only unless keys are provided at build time. To build the full local demo: `pnpm build --mode development`.

Proving runs single-threaded in the browser (about 1.5 s for a spend once the prover is warm). In our tests the bb.js nightly used here did not start its thread workers in the browser, so `VITE_BB_THREADS` should stay at 1.

## Scripts and tests

```sh
node scripts/sync.mjs     # ABIs (typed, from contracts/out-app), deployments, circuit and vendored tools
pnpm test                 # vitest: error decoding, check logic, spend construction, device keys
pnpm test:e2e             # Playwright smoke test against the seeded chain (desktop and phone)
pnpm build
```

The files in `src/vendor/` are copies of `tools/zk`, `tools/mldsa` and `device/lib`, refreshed by `scripts/sync.mjs`; `src/abi/` is generated from the Foundry artifacts.

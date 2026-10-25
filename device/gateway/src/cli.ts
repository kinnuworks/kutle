// Kütle gateway: samples the battery gauge, batches readings, gets each batch
// signed (by the edge device, or locally as a fallback) and anchors it in
// ReadingLog.
//
//   node gateway/src/cli.ts sample                 one reading from this Mac, stored locally
//   node gateway/src/cli.ts run [--interval 60] [--batch 30]
//   node gateway/src/cli.ts anchor [--max 256]     sign and anchor pending readings now
//   node gateway/src/cli.ts prove (--reading '<json>' | --wire <hex> | --seq <n> --index <i>)
//   node gateway/src/cli.ts status
//
// Environment:
//   RPC_URL, READING_LOG, PASSPORT_ID, DEVICE_ID   target chain and device
//   RELAYER_KEY                                    pays for anchor transactions
//   KUTLE_SIGNER=edge|gateway                      signing mode (default edge)
//   KUTLE_DEVICE=/dev/cu.usbmodemXXXX | sim:<cmd>  edge mode transport
//   KUTLE_KEYSTORE, KUTLE_KEYSTORE_PASSPHRASE      gateway (fallback) mode
//   KUTLE_DATA_DIR                                 default gateway/data

import { parseArgs } from "node:util";
import type { Hex } from "viem";
import { asAddress, asBytes32, clients, requireEnv } from "../../lib/chain.ts";
import { toWireHex, type Reading } from "../../lib/reading.ts";
import { openSigner } from "../../lib/signer.ts";
import { anchorPending, buildProof, chainCursor, verifyOnChain, type AnchorTarget } from "./anchor.ts";
import { sampleThisMac } from "./ioreg.ts";
import { Store } from "./store.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    interval: { type: "string", default: "60" },
    batch: { type: "string", default: "30" },
    max: { type: "string", default: "256" },
    wire: { type: "string" },
    reading: { type: "string" },
    seq: { type: "string" },
    index: { type: "string" },
  },
});

const cmd = positionals[0] ?? "help";

function target(c: Awaited<ReturnType<typeof clients>>): AnchorTarget {
  return {
    clients: c,
    readingLog: asAddress(requireEnv("READING_LOG")),
    passportId: BigInt(requireEnv("PASSPORT_ID")),
    deviceId: asBytes32(requireEnv("DEVICE_ID")),
  };
}

const signerOpts = () => ({
  mode: process.env.KUTLE_SIGNER ?? "edge",
  device: process.env.KUTLE_DEVICE,
  keystore: process.env.KUTLE_KEYSTORE,
});

async function main() {
  const deviceId = () => asBytes32(requireEnv("DEVICE_ID"));
  switch (cmd) {
    case "sample": {
      const store = new Store(deviceId());
      const r = sampleThisMac();
      store.appendReading(r);
      console.log(JSON.stringify(r));
      return;
    }
    case "anchor": {
      const c = await clients(requireEnv("RPC_URL"), process.env.RELAYER_KEY as Hex | undefined);
      const store = new Store(deviceId());
      const signer = await openSigner(signerOpts());
      try {
        const b = await anchorPending(target(c), store, signer, { maxBatch: Number(values.max) });
        console.log(b ? JSON.stringify({ seq: b.seq, batchId: b.batchId, count: b.count, txHash: b.txHash }) : "nothing to anchor");
      } finally {
        signer.close();
      }
      return;
    }
    case "run": {
      const c = await clients(requireEnv("RPC_URL"), process.env.RELAYER_KEY as Hex | undefined);
      const t = target(c);
      const store = new Store(t.deviceId);
      const signer = await openSigner(signerOpts());
      const intervalMs = Number(values.interval) * 1000;
      const batch = Number(values.batch);
      console.error(`sampling every ${values.interval}s, anchoring every ${batch} readings, signer ${signer.mode} ${signer.address}`);
      let stop = false;
      process.on("SIGINT", () => {
        stop = true;
      });
      while (!stop) {
        try {
          const r = sampleThisMac();
          store.appendReading(r);
          if (store.pending().readings.length >= batch) await anchorPending(t, store, signer, { maxBatch: batch });
        } catch (e) {
          console.error(`error: ${(e as Error).message}`);
        }
        await new Promise((res) => setTimeout(res, intervalMs));
      }
      signer.close();
      return;
    }
    case "prove": {
      const c = await clients(requireEnv("RPC_URL"));
      const store = new Store(deviceId());
      const p = buildProof(store, {
        wire: values.reading ? toWireHex(JSON.parse(values.reading) as Reading) : values.wire,
        seq: values.seq,
        index: values.index !== undefined ? Number(values.index) : undefined,
      });
      const ok = await verifyOnChain(c, asAddress(requireEnv("READING_LOG")), p);
      console.log(JSON.stringify({ ...p, verifyReading: ok }, null, 2));
      if (!ok) process.exitCode = 1;
      return;
    }
    case "status": {
      const c = await clients(requireEnv("RPC_URL"));
      const t = target(c);
      const store = new Store(t.deviceId);
      const cur = await chainCursor(t);
      console.log(
        JSON.stringify(
          {
            chainId: c.chainId.toString(),
            nextSeq: cur.nextSeq.toString(),
            lastToTs: cur.lastToTs.toString(),
            pending: store.pending().readings.length,
            anchoredLocally: store.batches().length,
            dataDir: store.dir,
          },
          null,
          2,
        ),
      );
      return;
    }
    default:
      console.log("usage: cli.ts sample | run [--interval s] [--batch n] | anchor [--max n] | prove (--reading json | --wire hex | --seq n --index i) | status");
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

// Local chain for developing and demoing the app.
//
//   node scripts/dev-chain.mjs [--port 8545] [--no-build] [--no-live] [--interval 30]
//
// 1. builds the contracts into contracts/out-app (another process owns contracts/out),
// 2. starts anvil (osaka, no code-size limit, genesis 430 days in the past),
// 3. deploys with contracts/script/Deploy.s.sol using anvil's default keys for every role,
// 4. seeds a full story with real cryptography: ML-DSA-44 + ECDSA device keys, signed
//    reading batches, a model registered through the council and timelock, health
//    grades, a second-life handoff, a co-signed assay, recycled-metal notes, and two
//    spends with real UltraHonk proofs,
// 5. syncs ABIs, the deployment and the demo data into app/, then keeps anvil running
//    and anchors a new signed batch for the demo device every --interval seconds.
//
// Every key used here is a public anvil or demo key. Never point this at a real network.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import {
  createPublicClient, createWalletClient, http, keccak256, stringToHex, encodeFunctionData, decodeEventLog,
  parseEventLogs, toHex, zeroHash,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import * as abi from "../src/abi/index.ts";
import { deviceKey, blobOf, rawDeployInitcode, hybridSign } from "../src/lib/device.ts";
import { generateReadings, batchOf } from "../src/lib/readings.ts";
import {
  NoteTree, buildSpend, bindingOf, noteSalt, ownerCommit, noteLeaf, toHex32,
} from "../src/lib/zk/notes.ts";
import { proveSpend } from "../src/lib/zk/prover.ts";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const repo = resolve(app, "..");
const contractsDir = resolve(repo, "contracts");

const { values: opt } = parseArgs({
  options: {
    port: { type: "string", default: process.env.ANVIL_PORT ?? "8545" },
    "no-build": { type: "boolean", default: false },
    "no-live": { type: "boolean", default: false },
    interval: { type: "string", default: "30" },
  },
});
const PORT = Number(opt.port);
const RPC = `http://127.0.0.1:${PORT}`;
const FORGE = process.env.FORGE ?? `${process.env.HOME}/.foundry/bin/forge`;
const ANVIL = process.env.ANVIL ?? `${process.env.HOME}/.foundry/bin/anvil`;
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil default
const DAY = 86_400;

const log = (...a) => console.log("[dev-chain]", ...a);

// ---------------------------------------------------------------- accounts

const keyOf = (i) => toHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey);
const ROLE_INDEX = {
  deployer: 0, council1: 1, council2: 2, council3: 3, manufacturer: 4, grader: 5, repurposer: 6,
  authority: 7, registrar: 8, recycler: 9, lab: 10, secondLife: 11, unaccreditedLab: 12, relayer: 13,
};
const KEYS = Object.fromEntries(Object.entries(ROLE_INDEX).map(([k, i]) => [k, keyOf(i)]));
const ACC = Object.fromEntries(Object.entries(KEYS).map(([k, pk]) => [k, privateKeyToAccount(pk)]));

// Demo note-owner secrets (field elements). The maker console uses MAKER_SECRET.
const MAKER_SECRET = 0x1b7e5a0c3d9f42e8a6b1c7d2e4f60a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4fn;
const ATTACKER_SECRET = 0x0a77ac4e5d6c7b8a9f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f708n;

// ---------------------------------------------------------------- anvil

let anvilProc;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function startAnvil(genesis) {
  try {
    await rpc("eth_chainId");
    throw new Error(`something already listens on ${RPC}; stop it or pass --port`);
  } catch (e) {
    if (String(e.message).includes("already listens")) throw e;
  }
  anvilProc = spawn(ANVIL, [
    "--hardfork", "osaka", "--port", String(PORT), "--accounts", "16", "--disable-code-size-limit",
    "--timestamp", String(genesis), "--chain-id", "31337", "--silent",
  ], { stdio: ["ignore", "inherit", "inherit"] });
  anvilProc.on("exit", (code) => {
    log(`anvil exited (${code})`);
    process.exit(code ?? 0);
  });
  for (let i = 0; i < 100; i++) {
    try {
      await rpc("eth_chainId");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

const cleanup = () => anvilProc?.kill("SIGTERM");
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

// ---------------------------------------------------------------- clients

const pub = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 50 });
const wallets = Object.fromEntries(Object.entries(ACC).map(([k, a]) => [k, createWalletClient({ account: a, chain: foundry, transport: http(RPC), pollingInterval: 50 })]));

let clock = 0;
async function at(ts) {
  if (ts <= clock) ts = clock + 1;
  await rpc("evm_setNextBlockTimestamp", [toHex(ts)]);
  await rpc("evm_mine");
  clock = ts;
}

async function send(role, address, contractAbi, functionName, args, extra = {}) {
  const w = wallets[role];
  const { request } = await pub.simulateContract({ account: w.account, address, abi: contractAbi, functionName, args, ...extra });
  const hash = await w.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  const blk = await pub.getBlock({ blockNumber: receipt.blockNumber });
  clock = Math.max(clock, Number(blk.timestamp));
  return { hash, receipt, logs: parseEventLogs({ abi: contractAbi, logs: receipt.logs }) };
}

async function deployRaw(role, runtime) {
  const hash = await wallets[role].sendTransaction({ data: rawDeployInitcode(runtime) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error("raw deploy failed");
  return r.contractAddress;
}

// ---------------------------------------------------------------- build + deploy

function forge(args, env = {}) {
  const r = spawnSync(FORGE, args, {
    cwd: contractsDir, stdio: "inherit",
    env: { ...process.env, FOUNDRY_OUT: "out-app", FOUNDRY_CACHE_PATH: "cache-app", FOUNDRY_PROFILE: "script", ...env },
  });
  if (r.status !== 0) throw new Error(`forge ${args[0]} failed`);
}

function deploy() {
  forge(["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--disable-code-size-limit", "--slow"], {
    DEPLOYER_KEY: KEYS.deployer,
    COUNCIL_1: ACC.council1.address, COUNCIL_2: ACC.council2.address, COUNCIL_3: ACC.council3.address,
    TIMELOCK_DELAY: "3600",
    MANUFACTURER: ACC.manufacturer.address, GRADER: ACC.grader.address, REPURPOSER: ACC.repurposer.address,
    AUTHORITY: ACC.authority.address, REGISTRAR: ACC.registrar.address, RECYCLER: ACC.recycler.address, LAB: ACC.lab.address,
  });
  return JSON.parse(readFileSync(resolve(contractsDir, "deployments/31337.json"), "utf8"));
}

// ---------------------------------------------------------------- story

const sha256hex = (s) => "0x" + createHash("sha256").update(s).digest("hex");

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const genesis = now - 430 * DAY;
  clock = genesis;

  if (!opt["no-build"]) {
    log("building contracts into contracts/out-app");
    forge(["build", "--skip", "test"]);
  }
  spawnSync("node", [resolve(here, "sync.mjs"), "--abi-only"], { stdio: "inherit" });

  log(`starting anvil on ${RPC}`);
  await startAnvil(genesis);
  log("deploying with contracts/script/Deploy.s.sol");
  const D = deploy();
  log("deployed", D);

  const demo = { chainId: 31337, generatedAt: new Date().toISOString(), roles: {}, devices: {}, passports: {}, batches: {}, txs: {}, notes: {}, model: {} };
  for (const [k, a] of Object.entries(ACC)) demo.roles[k] = a.address;
  const readingsStore = {};

  // ---------- devices ----------
  async function registerDevice(name, label, operatorRole) {
    const k = deviceKey(label);
    const deviceId = keccak256(stringToHex(`kutle-demo-device-${name}`));
    const blob = await deployRaw("registrar", blobOf(k));
    const digest = await pub.readContract({ address: D.deviceRegistry, abi: abi.deviceRegistryAbi, functionName: "popDigest", args: [deviceId, 1, k.ecdsa.address, k.pkHash] });
    const { ecdsaSig, mldsaSig } = await hybridSign(k, digest);
    const tx = await send("registrar", D.deviceRegistry, abi.deviceRegistryAbi, "registerDevice", [deviceId, ACC[operatorRole].address, k.ecdsa.address, k.pk, blob, ecdsaSig, mldsaSig]);
    demo.devices[name] = { deviceId, label, operator: ACC[operatorRole].address, ecdsaSigner: k.ecdsa.address, pkBlob: blob, pkHash: k.pkHash, registerTx: tx.hash };
    log(`device ${name} registered (${deviceId.slice(0, 10)})`);
    return { k, deviceId };
  }

  const passportJson = (fields) => JSON.stringify(fields);
  async function issue(deviceName, p) {
    const d = demo.devices[deviceName];
    const record = passportJson({ ...p.record, deviceId: d.deviceId });
    const params = {
      deviceId: d.deviceId, category: p.category, massGrams: p.massGrams, capacityWh: p.capacityWh,
      composition: p.composition, dataHash: sha256hex(record), gs1Hash: keccak256(stringToHex(p.gs1)), uri: p.uri,
    };
    const tx = await send("manufacturer", D.passportRegistry, abi.passportRegistryAbi, "issue", [params]);
    const ev = tx.logs.find((l) => l.eventName === "Issued");
    const id = Number(ev.args.passportId);
    demo.passports[String(id)] = { gs1: p.gs1, record: JSON.parse(record), device: deviceName };
    log(`passport #${id} issued (${p.gs1})`);
    return id;
  }

  const seqOf = {};
  async function anchor(deviceName, key, passportId, readings, relayer = "relayer") {
    const d = demo.devices[deviceName];
    const b = batchOf(readings);
    const seq = seqOf[deviceName] ?? 0;
    const digest = await pub.readContract({ address: D.readingLog, abi: abi.readingLogAbi, functionName: "batchDigest", args: [d.deviceId, BigInt(passportId), BigInt(seq), b.root, BigInt(b.fromTs), BigInt(b.toTs), b.count] });
    const { ecdsaSig, mldsaSig } = await hybridSign(key, digest);
    const tx = await send(relayer, D.readingLog, abi.readingLogAbi, "anchor", [d.deviceId, BigInt(passportId), BigInt(seq), b.root, BigInt(b.fromTs), BigInt(b.toTs), b.count, ecdsaSig, mldsaSig]);
    seqOf[deviceName] = seq + 1;
    const batchId = tx.logs.find((l) => l.eventName === "BatchAnchored").args.batchId;
    readingsStore[batchId] = readings;
    log(`anchored batch ${seq} for ${deviceName} -> passport #${passportId} (gas ${tx.receipt.gasUsed})`);
    return batchId;
  }

  // ---------- governance (council 2 of 3 -> timelock) ----------
  const TTL = BigInt(3650 * DAY);
  async function councilRun(target, data, execute = true) {
    const p = await send("council1", D.council, abi.kutleCouncilAbi, "propose", [target, 0n, data, TTL]);
    const id = p.logs.find((l) => l.eventName === "Proposed").args.id;
    await send("council2", D.council, abi.kutleCouncilAbi, "approve", [id]);
    if (execute) await send("relayer", D.council, abi.kutleCouncilAbi, "execute", [id]);
    return id;
  }
  async function govern(target, data, salt, { executeFinal = true } = {}) {
    const delay = await pub.readContract({ address: D.timelock, abi: abi.timelockControllerAbi, functionName: "getMinDelay" });
    const schedule = encodeFunctionData({ abi: abi.timelockControllerAbi, functionName: "schedule", args: [target, 0n, data, zeroHash, salt, delay] });
    await councilRun(D.timelock, schedule);
    await at(clock + Number(delay) + 5);
    const exec = encodeFunctionData({ abi: abi.timelockControllerAbi, functionName: "execute", args: [target, 0n, data, zeroHash, salt] });
    return councilRun(D.timelock, exec, executeFinal);
  }

  // ======================================================== the story
  await at(genesis + 60);
  const A = await registerDevice("A", "fixture:deviceA-v1", "manufacturer");
  const storyRecord = {
    batteryCategory: "EV", manufacturer: "Kütle demo cell plant, Gemlik (demo operator)", model: "KD-60 NMC811",
    chemistry: "NMC811 / graphite", nominalVoltage_V: 355, ratedCapacity_Ah: 169, manufacturedOn: new Date((genesis - 900 * DAY) * 1000).toISOString().slice(0, 10),
    carbonFootprint_kgCO2e_per_kWh: 72, hazardousSubstances: ["none above Annex I thresholds"], warranty: "8 years or 160,000 km",
  };
  const pStory = await issue("A", {
    category: 1, massGrams: 400_000, capacityWh: 60_000, composition: [4_500n, 6_000n, 36_000n, 0n],
    gs1: "https://id.kutle.example/01/08690000000017/21/KD60-000417", uri: "ipfs://kutle-demo/passport/KD60-000417", record: storyRecord,
  });
  demo.passports.story = pStory;

  // Two older packs that will reach the recycler.
  await at(genesis + 5 * DAY);
  const B = await registerDevice("B", "fixture:deviceB-v1", "manufacturer");
  const P2 = await registerDevice("R2", "pack-r2", "manufacturer");
  const pRecA = await issue("B", { category: 1, massGrams: 400_000, capacityWh: 60_000, composition: [4_500n, 6_000n, 36_000n, 0n], gs1: "https://id.kutle.example/01/08690000000017/21/KD60-000102", uri: "ipfs://kutle-demo/passport/KD60-000102", record: { ...storyRecord, manufacturedOn: "2017-03-14" } });
  const pRecB = await issue("R2", { category: 1, massGrams: 330_000, capacityWh: 50_000, composition: [3_000n, 5_000n, 30_000n, 0n], gs1: "https://id.kutle.example/01/08690000000017/21/KD50-000088", uri: "ipfs://kutle-demo/passport/KD50-000088", record: { ...storyRecord, model: "KD-50 NMC622", chemistry: "NMC622 / graphite", manufacturedOn: "2016-11-02" } });

  // Model, registered through the council and the timelock.
  let metrics = null;
  const metricsPath = resolve(repo, "model/artifacts/metrics.json");
  if (existsSync(metricsPath)) {
    try {
      const m = JSON.parse(readFileSync(metricsPath, "utf8"));
      if (m.registrable && m.maeBps < m.baselineMaeBps && m.coverageBps >= 8500) metrics = m;
    } catch { /* fall back */ }
  }
  const weightsPath = resolve(repo, "model/artifacts/model.json");
  const model = {
    weightsHash: existsSync(weightsPath) ? sha256hex(readFileSync(weightsPath)) : keccak256(stringToHex("kutle-soh demo weights")),
    evalDataHash: keccak256(stringToHex("NASA PCoE B0005 B0006 B0007 B0018 B0034 B0036")),
    codeHash: keccak256(stringToHex("model/kutle_health")),
    maeBps: metrics ? Math.round(metrics.maeBps) : 150,
    baselineMaeBps: metrics ? Math.round(metrics.baselineMaeBps) : 320,
    coverageBps: metrics ? Math.round(metrics.coverageBps) : 9_000,
    registeredAt: 0n, active: false,
    uri: metrics ? "model/artifacts/metrics.json" : "model/README.md (demo values until model/artifacts/metrics.json exists)",
  };
  const MODEL_ID = keccak256(stringToHex("kutle-soh-v1"));
  await at(genesis + 10 * DAY);
  await govern(D.modelRegistry, encodeFunctionData({ abi: abi.modelRegistryAbi, functionName: "register", args: [MODEL_ID, model] }), keccak256(stringToHex("register kutle-soh-v1")));
  demo.model = { id: MODEL_ID, fromMetricsFile: Boolean(metrics) };
  log("model registered through council + timelock");

  // Story pack readings and grades.
  const st = { designCapacity_mAh: 60_000, soh: 0.885, cycles: 1_150, fadePerCycle: 0.000_105, cyclesPerDay: 0.9 };
  async function storyBatch(dayFromGenesis, count, step, seedNum, passportId) {
    const from = genesis + dayFromGenesis * DAY;
    const rs = generateReadings(st, from, count, step, seedNum);
    await at(rs[rs.length - 1].timestamp + 120);
    return anchor("A", A.k, passportId, rs);
  }
  const grade = async (pid, batchId, soh, lo, hi, rul) => {
    const tx = await send("grader", D.passportRegistry, abi.passportRegistryAbi, "recordHealth", [BigInt(pid), batchId, MODEL_ID, soh, lo, hi, rul]);
    return tx.hash;
  };

  const b0 = await storyBatch(20, 48, 1800, 11, pStory);
  await grade(pStory, b0, 8_770, 8_520, 9_010, 1_900);
  const b1 = await storyBatch(180, 48, 1800, 12, pStory);
  await grade(pStory, b1, 8_120, 7_860, 8_390, 1_150);

  // The two old packs: one batch each, graded for recycling.
  const stB = { designCapacity_mAh: 60_000, soh: 0.55, cycles: 3_400, fadePerCycle: 0.0001, cyclesPerDay: 0.8 };
  await at(genesis + 300 * DAY);
  let rsB = generateReadings(stB, clock - 6 * 3600, 24, 900, 21);
  const bB = await anchor("B", B.k, pRecA, rsB);
  await grade(pRecA, bB, 5_240, 5_010, 5_480, 0);
  const stR2 = { designCapacity_mAh: 50_000, soh: 0.52, cycles: 3_900, fadePerCycle: 0.0001, cyclesPerDay: 0.8 };
  rsB = generateReadings(stR2, clock + 60, 24, 900, 22);
  await at(rsB[rsB.length - 1].timestamp + 60);
  const bR2 = await anchor("R2", P2.k, pRecB, rsB);
  await grade(pRecB, bR2, 4_980, 4_720, 5_230, 0);

  // Recycler batch 1: intake, co-signed assay, notes.
  await at(genesis + 310 * DAY);
  let tx = await send("recycler", D.conservationLedger, abi.conservationLedgerAbi, "openBatch", []);
  const batch1 = tx.logs.find((l) => l.eventName === "BatchOpened").args.batchId;
  await send("recycler", D.conservationLedger, abi.conservationLedgerAbi, "intake", [batch1, [BigInt(pRecA), BigInt(pRecB)]]);
  await at(clock + 4 * DAY);
  const assay = {
    batchId: batch1,
    recovered: [7_125n, 6_600n, 63_360n, 0n],
    loss: [375n, 4_400n, 2_640n, 0n],
    residual: [0n, 0n, 0n, 0n],
    reportHash: sha256hex("assay report KTL-2026-0117, ICP-OES, demo lab"),
    lab: ACC.lab.address,
    nonce: 0,
    deadline: BigInt(now + 3650 * DAY),
  };
  const domain = { name: "Kutle ConservationLedger", version: "1", chainId: 31337, verifyingContract: D.conservationLedger };
  const types = { Assay: [
    { name: "batchId", type: "uint256" }, { name: "recovered", type: "uint64[4]" }, { name: "loss", type: "uint64[4]" },
    { name: "residual", type: "uint64[4]" }, { name: "reportHash", type: "bytes32" }, { name: "lab", type: "address" },
    { name: "nonce", type: "uint32" }, { name: "deadline", type: "uint64" },
  ] };
  const recSig = await ACC.recycler.signTypedData({ domain, types, primaryType: "Assay", message: assay });
  const labSig = await ACC.lab.signTypedData({ domain, types, primaryType: "Assay", message: assay });
  tx = await send("recycler", D.conservationLedger, abi.conservationLedgerAbi, "settle", [assay, recSig, labSig]);
  demo.txs.settle = tx.hash;
  demo.batches.settled = Number(batch1);
  log("assay settled for batch", batch1);

  // Notes: the maker's wallet gets salts 0.., the attacker wallet one note.
  let makerSalt = 0;
  const makerNotes = [];
  async function issueNotes(element, gramsList, secret = MAKER_SECRET, startSalt = null) {
    const commits = [];
    for (const g of gramsList) {
      const i = startSalt ?? makerSalt++;
      commits.push(ownerCommit(secret, noteSalt(secret, i)));
      if (secret === MAKER_SECRET) makerNotes.push({ element, grams: g, saltIndex: i });
    }
    const t = await send("recycler", D.conservationLedger, abi.conservationLedgerAbi, "issueNotes", [batch1, element, gramsList.map(BigInt), commits]);
    return t.hash;
  }
  await at(clock + DAY);
  demo.txs.notesCobalt = await issueNotes(0, [3_000, 2_000, 1_500]);
  demo.txs.notesLithium = await issueNotes(1, [400, 300]);
  demo.txs.notesNickel = await issueNotes(2, [2_500, 1_500, 2_000]);
  demo.txs.notesAttacker = await issueNotes(0, [500], ATTACKER_SECRET, 0);

  // Recycler batch 2: two more packs fed in, no assay yet (used by the attack console).
  await at(genesis + 330 * DAY);
  await registerDevice("R4", "pack-r4", "manufacturer");
  await registerDevice("R5", "pack-r5", "manufacturer");
  const pR4 = await issue("R4", { category: 1, massGrams: 400_000, capacityWh: 60_000, composition: [4_500n, 6_000n, 36_000n, 0n], gs1: "https://id.kutle.example/01/08690000000017/21/KD60-000131", uri: "ipfs://kutle-demo/passport/KD60-000131", record: { ...storyRecord, manufacturedOn: "2017-06-20" } });
  const pR5 = await issue("R5", { category: 1, massGrams: 400_000, capacityWh: 60_000, composition: [4_500n, 6_000n, 36_000n, 0n], gs1: "https://id.kutle.example/01/08690000000017/21/KD60-000139", uri: "ipfs://kutle-demo/passport/KD60-000139", record: { ...storyRecord, manufacturedOn: "2017-06-22" } });
  tx = await send("recycler", D.conservationLedger, abi.conservationLedgerAbi, "openBatch", []);
  const batch2 = tx.logs.find((l) => l.eventName === "BatchOpened").args.batchId;
  await send("recycler", D.conservationLedger, abi.conservationLedgerAbi, "intake", [batch2, [BigInt(pR4), BigInt(pR5)]]);
  demo.batches.pending = Number(batch2);

  // Story pack: a fresh grade, then the second-life handoff.
  const b2 = await storyBatch(365, 48, 1800, 13, pStory);
  await grade(pStory, b2, 7_400, 7_050, 7_700, 620);
  await at(clock + 10 * DAY);
  tx = await send("repurposer", D.passportRegistry, abi.passportRegistryAbi, "repurpose", [
    BigInt(pStory), ACC.secondLife.address, A.deviceId, 3, 42_000,
    sha256hex(JSON.stringify({ ...storyRecord, batteryCategory: "industrial", secondLife: "stationary storage for a 250 kWp rooftop solar site, Bursa" })),
    keccak256(stringToHex("https://id.kutle.example/01/08690000000017/21/KD60-000417-SL1")), "ipfs://kutle-demo/passport/KD60-000417-SL1",
  ]);
  const pChild = Number(tx.logs.find((l) => l.eventName === "Repurposed").args.childId);
  demo.passports.storyChild = pChild;
  demo.passports[String(pChild)] = { gs1: "https://id.kutle.example/01/08690000000017/21/KD60-000417-SL1", record: { ...storyRecord, batteryCategory: "industrial", secondLife: "stationary storage for a 250 kWp rooftop solar site, Bursa", deviceId: A.deviceId }, device: "A" };
  demo.txs.repurpose = tx.hash;
  log(`passport #${pStory} repurposed into #${pChild}`);

  // A new battery whose metal is partly recycled, and a second pack the attack console targets.
  await at(clock + 3 * DAY);
  const N1 = await registerDevice("N1", "pack-n1", "manufacturer");
  const C = await registerDevice("C", "pack-c-revoked", "manufacturer");
  const newRecord = { ...storyRecord, model: "KD-62 NMC811", manufacturedOn: new Date(clock * 1000).toISOString().slice(0, 10), carbonFootprint_kgCO2e_per_kWh: 61 };
  const pNew = await issue("N1", { category: 1, massGrams: 410_000, capacityWh: 62_000, composition: [6_000n, 7_000n, 40_000n, 0n], gs1: "https://id.kutle.example/01/08690000000017/21/KD62-000001", uri: "ipfs://kutle-demo/passport/KD62-000001", record: newRecord });
  const pTarget = await issue("C", { category: 1, massGrams: 410_000, capacityWh: 62_000, composition: [6_000n, 7_000n, 40_000n, 0n], gs1: "https://id.kutle.example/01/08690000000017/21/KD62-000002", uri: "ipfs://kutle-demo/passport/KD62-000002", record: { ...newRecord } });
  demo.passports.newBattery = pNew;
  // The new pack's first signed readings and grade, from end-of-line testing.
  const stN = { designCapacity_mAh: 62_000, soh: 0.995, cycles: 2, fadePerCycle: 0.0001, cyclesPerDay: 1 };
  const rsN = generateReadings(stN, clock + 60, 24, 600, 31);
  await at(rsN[rsN.length - 1].timestamp + 60);
  const bN = await anchor("N1", N1.k, pNew, rsN);
  await grade(pNew, bN, 9_880, 9_720, 9_990, 3_200);
  demo.passports.target = pTarget;
  // Device C's key is reported stolen and revoked.
  tx = await send("authority", D.deviceRegistry, abi.deviceRegistryAbi, "revokeKey", [C.deviceId, keccak256(stringToHex("reported stolen"))]);
  demo.txs.revokeKey = tx.hash;

  // Spends with real proofs.
  const circuit = JSON.parse(readFileSync(resolve(app, "public/circuits/shielded_spend.json"), "utf8"));
  const binding = bindingOf(31337, D.notePool);
  async function loadTree() {
    const [minted, change] = await Promise.all([
      pub.getContractEvents({ address: D.notePool, abi: abi.notePoolAbi, eventName: "NoteMinted", fromBlock: 0n }),
      pub.getContractEvents({ address: D.notePool, abi: abi.notePoolAbi, eventName: "ChangeNote", fromBlock: 0n }),
    ]);
    return NoteTree.fromEvents([...minted, ...change].map((l) => l.args));
  }
  const changeNotes = [];
  async function spendNotes(secret, element, picks, declared, passportId, { submit = true } = {}) {
    const tree = await loadTree();
    const notes = picks.map((n) => {
      const salt = noteSalt(secret, n.saltIndex);
      return { salt, grams: BigInt(n.grams), leafIndex: -1, commit: ownerCommit(secret, salt) };
    });
    for (const n of notes) {
      n.leafIndex = tree.indexOf(noteLeaf(element, n.grams, n.commit));
      if (n.leafIndex < 0) throw new Error("note not found in tree");
    }
    const total = notes.reduce((s, n) => s + n.grams, 0n);
    const change = total - BigInt(declared);
    const changeSaltIndex = change > 0n ? makerSalt++ : null;
    const changeCommit = change > 0n ? ownerCommit(secret, noteSalt(secret, changeSaltIndex)) : 0n;
    const built = buildSpend({ tree, element, passportId: BigInt(passportId), declaredGrams: BigInt(declared), ownerSecret: secret, notes, changeGrams: change, changeOwnerCommit: changeCommit, binding });
    log(`proving spend of ${declared} g (element ${element}) into #${passportId}`);
    const out = await proveSpend(circuit, built.inputs);
    log(`proof ${(out.proof.length - 2) / 2} bytes, witness ${out.timings.witnessMs} ms, prove ${out.timings.proveMs} ms`);
    const nullifiers = built.nullifiers.map((x) => x);
    const args = [BigInt(passportId), element, BigInt(declared), built.root, nullifiers, built.changeLeaf, out.proof];
    if (!submit) return { args: args.map((a) => (typeof a === "bigint" ? a.toString() : Array.isArray(a) ? a.map(String) : a)), timings: out.timings };
    const t = await send("manufacturer", D.notePool, abi.notePoolAbi, "spend", args);
    if (change > 0n) {
      const ev = t.logs.find((l) => l.eventName === "ChangeNote");
      changeNotes.push({ element, grams: change.toString(), saltIndex: changeSaltIndex, leafIndex: Number(ev.args.leafIndex) });
    }
    return { hash: t.hash, timings: out.timings, gas: t.receipt.gasUsed.toString() };
  }
  await at(clock + 5 * DAY);
  const coSalt = makerNotes.find((n) => n.element === 0 && n.grams === 1_500);
  const sCo = await spendNotes(MAKER_SECRET, 0, [coSalt], 1_200, pNew);
  demo.txs.spendCobalt = sCo.hash;
  demo.notes.proofTimingsNode = sCo.timings;
  const liSalt = makerNotes.find((n) => n.element === 1 && n.grams === 400);
  const sLi = await spendNotes(MAKER_SECRET, 1, [liSalt], 400, pNew);
  demo.txs.spendLithium = sLi.hash;
  // Held back: a valid proof for the new battery from the attacker wallet's note,
  // which the attack console submits under another passport.
  const held = await spendNotes(ATTACKER_SECRET, 0, [{ saltIndex: 0, grams: 500 }], 500, pNew, { submit: false });
  demo.notes.heldBackProof = { provenFor: pNew, args: held.args };
  demo.notes.makerChange = changeNotes;
  demo.notes.makerSaltsUsed = makerSalt;

  // Spare end-of-life packs for the recycler console.
  await at(clock + 2 * DAY);
  demo.passports.spares = [];
  for (const n of ["S1", "S2", "S3", "S4"]) {
    await registerDevice(n, `pack-${n.toLowerCase()}`, "manufacturer");
    const id = await issue(n, { category: 1, massGrams: 400_000, capacityWh: 60_000, composition: [4_500n, 6_000n, 36_000n, 0n], gs1: `https://id.kutle.example/01/08690000000017/21/KD60-0002${n.slice(1)}0`, uri: `ipfs://kutle-demo/passport/KD60-0002${n.slice(1)}0`, record: { ...storyRecord, manufacturedOn: "2018-01-09" } });
    demo.passports.spares.push(id);
  }

  // A model that loses to its baseline, scheduled through the timelock. The final
  // council proposal is approved but left for the attack console to execute.
  const bad = { ...model, maeBps: 400, baselineMaeBps: 320, uri: "a model that loses to its baseline" };
  const badId = await govern(D.modelRegistry, encodeFunctionData({ abi: abi.modelRegistryAbi, functionName: "register", args: [keccak256(stringToHex("kutle-soh-overfit")), bad] }), keccak256(stringToHex("bad model")), { executeFinal: false });
  demo.txs.badModelProposal = badId.toString();

  // Second life: the pack keeps reporting through the same gauge.
  const childFrom = clock + DAY;
  st.cyclesPerDay = 0.6;
  let rs = generateReadings(st, childFrom, 48, 1800, 14);
  await at(rs[rs.length - 1].timestamp + 60);
  await anchor("A", A.k, pChild, rs);
  // Bring the chain clock to the present.
  rs = generateReadings(st, now - 2 * DAY, 48, 1800, 15);
  await at(now - 60);
  await anchor("A", A.k, pChild, rs);
  await at(now);

  demo.deviceSeq = seqOf;
  demo.makerSecretHint = "VITE_DEMO_MAKER_SECRET";
  writeOutputs(D, demo, readingsStore);
  log("seeded. app config written.");

  if (!opt["no-live"]) live(D, A, pChild, st, readingsStore, demo);
  else log(`anvil keeps running on ${RPC}; Ctrl-C to stop`);
}

function writeOutputs(D, demo, readingsStore) {
  spawnSync("node", [resolve(here, "sync.mjs")], { stdio: "inherit" });
  const pubDir = resolve(app, "public/demo");
  mkdirSync(pubDir, { recursive: true });
  const ser = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(resolve(pubDir, "31337.json"), ser(demo) + "\n");
  writeFileSync(resolve(pubDir, "31337-readings.json"), ser(readingsStore) + "\n");
  const env = [
    "# Written by scripts/dev-chain.mjs. Testnet demo keys: anvil's public default",
    "# accounts, valid only on the local chain. Never put a real key here.",
    `VITE_RPC_URL=${RPC}`,
    "VITE_CHAIN_ID=31337",
    ...Object.entries(KEYS).map(([k, v]) => `VITE_DEMO_KEY_${k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}=${v}`),
    `VITE_DEMO_MAKER_SECRET=${toHex32(MAKER_SECRET)}`,
    `VITE_DEMO_ATTACKER_SECRET=${toHex32(ATTACKER_SECRET)}`,
    "",
  ].join("\n");
  writeFileSync(resolve(app, ".env.development.local"), env);
}

// Keeps the demo device reporting: one signed batch every --interval seconds.
function live(D, A, passportId, st, readingsStore, demo) {
  const interval = Number(opt.interval) * 1000;
  log(`live: anchoring a batch for device A every ${opt.interval} s (Ctrl-C to stop)`);
  let busy = false;
  let n = 100;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const d = demo.devices.A;
      const [seq, lastTo, blk] = await Promise.all([
        pub.readContract({ address: D.readingLog, abi: abi.readingLogAbi, functionName: "nextSeq", args: [d.deviceId] }),
        pub.readContract({ address: D.readingLog, abi: abi.readingLogAbi, functionName: "lastToTs", args: [d.deviceId] }),
        pub.getBlock(),
      ]);
      const status = await pub.readContract({ address: D.passportRegistry, abi: abi.passportRegistryAbi, functionName: "deviceOf", args: [BigInt(passportId)] });
      if (status !== d.deviceId) return; // passport no longer active
      const nowTs = Math.max(Number(blk.timestamp), Math.floor(Date.now() / 1000));
      const count = 10;
      const step = 3;
      const from = Math.max(Number(lastTo), nowTs - count * step);
      const rs = generateReadings(st, from, count, step, n++);
      const b = batchOf(rs);
      const digest = await pub.readContract({ address: D.readingLog, abi: abi.readingLogAbi, functionName: "batchDigest", args: [d.deviceId, BigInt(passportId), seq, b.root, BigInt(b.fromTs), BigInt(b.toTs), b.count] });
      const { ecdsaSig, mldsaSig } = await hybridSign(A.k, digest);
      const { request } = await pub.simulateContract({ account: ACC.relayer, address: D.readingLog, abi: abi.readingLogAbi, functionName: "anchor", args: [d.deviceId, BigInt(passportId), seq, b.root, BigInt(b.fromTs), BigInt(b.toTs), b.count, ecdsaSig, mldsaSig] });
      const hash = await wallets.relayer.writeContract(request);
      const r = await pub.waitForTransactionReceipt({ hash });
      const ev = parseEventLogs({ abi: abi.readingLogAbi, logs: r.logs }).find((l) => l.eventName === "BatchAnchored");
      readingsStore[ev.args.batchId] = rs;
      writeFileSync(resolve(app, "public/demo/31337-readings.json"), JSON.stringify(readingsStore, null, 2) + "\n");
      log(`live batch seq ${seq} anchored, gas ${r.gasUsed}`);
    } catch (e) {
      log("live anchor failed:", e.shortMessage ?? e.message);
    } finally {
      busy = false;
    }
  }, interval);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});

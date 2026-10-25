// Every check on the Verify page, run in the browser against the chain. Each
// check reports the calls it made so a reader can repeat them.

import { decodeFunctionData, keccak256, stringToHex, type Hex } from "viem";
import { deviceRegistryAbi, notePoolAbi, passportRegistryAbi, readingLogAbi, conservationLedgerAbi } from "../abi/index.ts";
import { FROM_BLOCK } from "../config/index.ts";
import { publicClient } from "./chain.ts";
import { dep, getAnchorTx, getBatches, getLedgerBatch, getModel, getNoteEvents, getPassport, getRecycledEvents, ledgerBatchCount } from "./data.ts";
import {
  BLOB_CODE_SIZE, conservationRows, gradeFor, modelVerdict, parsePassportRef, recycledMatches, verifyHybridOffline,
} from "./checks.ts";

export type CheckState = "pass" | "fail" | "na";
export interface CheckResult {
  id: string;
  state: CheckState;
  /** values interpolated into the localized title/detail by the page */
  facts: Record<string, string | number | boolean>;
  calls: string[];
}

export async function resolvePassportRef(input: string): Promise<bigint | null> {
  const direct = parsePassportRef(input);
  if (direct !== null) return direct;
  const s = input.trim();
  if (/^https?:\/\/.+\/01\/\d{8,14}/.test(s)) {
    const id = await publicClient.readContract({
      address: dep().passportRegistry, abi: passportRegistryAbi, functionName: "passportOfGs1", args: [keccak256(stringToHex(s))],
    });
    return id === 0n ? null : id;
  }
  return null;
}

/** Canonical ML-DSA public key of a device key version, read from its registration or rotation transaction. */
export async function devicePublicKey(deviceId: Hex, version: number): Promise<Hex | undefined> {
  const d = dep();
  const ev =
    version === 1
      ? await publicClient.getContractEvents({ address: d.deviceRegistry, abi: deviceRegistryAbi, eventName: "DeviceRegistered", args: { deviceId }, fromBlock: FROM_BLOCK })
      : (await publicClient.getContractEvents({ address: d.deviceRegistry, abi: deviceRegistryAbi, eventName: "KeyRotated", args: { deviceId }, fromBlock: FROM_BLOCK }))
          .filter((l) => Number(l.args.version) === version);
  if (!ev.length) return undefined;
  const tx = await publicClient.getTransaction({ hash: ev[0].transactionHash });
  const { functionName, args } = decodeFunctionData({ abi: deviceRegistryAbi, data: tx.input });
  if (functionName === "registerDevice") return (args as readonly unknown[])[3] as Hex;
  if (functionName === "rotateKey") return (args as readonly unknown[])[2] as Hex;
  return undefined;
}

export async function* runChecks(id: bigint): AsyncGenerator<CheckResult> {
  const d = dep();
  const { passport, health } = await getPassport(id);
  if (passport.status === 0) {
    yield { id: "exists", state: "fail", facts: { id: String(id) }, calls: [`PassportRegistry.passport(${id})`] };
    return;
  }
  yield {
    id: "exists", state: "pass",
    facts: { id: String(id), status: passport.status, category: passport.category, parent: String(passport.parentId), child: String(passport.childId) },
    calls: [`PassportRegistry.passport(${id})`],
  };

  // 1. device key suite and pinned verifier
  const dev = await publicClient.readContract({ address: d.deviceRegistry, abi: deviceRegistryAbi, functionName: "devices", args: [passport.deviceId] });
  const keyVersion = dev[1];
  const key = await publicClient.readContract({ address: d.deviceRegistry, abi: deviceRegistryAbi, functionName: "key", args: [passport.deviceId, keyVersion] });
  const suite = await publicClient.readContract({ address: d.deviceRegistry, abi: deviceRegistryAbi, functionName: "suites", args: [key.suite] });
  const [verifier, pinnedCodehash, enabled] = suite;
  const [verifierCode, blobCode] = await Promise.all([publicClient.getCode({ address: verifier }), publicClient.getCode({ address: key.pkBlob })]);
  const verifierHash = verifierCode ? keccak256(verifierCode) : "0x";
  const blobHash = blobCode ? keccak256(blobCode) : "0x";
  const blobSize = blobCode ? (blobCode.length - 2) / 2 : 0;
  const suiteOk = key.suite === 1 && enabled && verifierHash === pinnedCodehash && blobHash === key.pkBlobCodehash && blobSize === BLOB_CODE_SIZE;
  yield {
    id: "suite", state: suiteOk ? "pass" : "fail",
    facts: {
      suite: key.suite, enabled, verifier, verifierHash, pinnedCodehash, blobSize, keyVersion,
      revoked: key.revokedAt !== 0n, blobPinned: blobHash === key.pkBlobCodehash,
    },
    calls: [
      `DeviceRegistry.key(${passport.deviceId}, ${keyVersion})`,
      `DeviceRegistry.suites(${key.suite})`,
      `keccak256(eth_getCode(${verifier})) == verifierCodehash`,
      `keccak256(eth_getCode(${key.pkBlob})) == pkBlobCodehash, size ${blobSize}`,
    ],
  };

  // 2. reading batch signatures, re-verified in the browser
  const batches = await getBatches({ passportId: id });
  if (!batches.length) {
    yield { id: "signatures", state: "na", facts: { count: 0 }, calls: [`ReadingLog BatchAnchored(passportId=${id})`] };
  } else {
    let okCount = 0;
    let mldsaBytes = 0;
    let gas = 0n;
    const pkCache = new Map<string, Hex | undefined>();
    for (const b of batches) {
      const tx = await getAnchorTx(b.tx);
      gas = tx.gasUsed;
      mldsaBytes = tx.mldsaSigBytes;
      const digest = await publicClient.readContract({
        address: d.readingLog, abi: readingLogAbi, functionName: "batchDigest",
        args: [b.deviceId!, b.passportId!, b.seq!, b.root!, b.fromTs!, b.toTs!, b.count!],
      });
      const k = await publicClient.readContract({ address: d.deviceRegistry, abi: deviceRegistryAbi, functionName: "key", args: [b.deviceId!, b.keyVersion!] });
      const ck = `${b.deviceId}-${b.keyVersion}`;
      if (!pkCache.has(ck)) pkCache.set(ck, await devicePublicKey(b.deviceId!, Number(b.keyVersion)));
      const pk = pkCache.get(ck);
      if (!pk) continue;
      const r = await verifyHybridOffline({ digest, ecdsaSig: tx.ecdsaSig, mldsaSig: tx.mldsaSig, ecdsaSigner: k.ecdsaSigner, pk, pkHash: k.pkHash });
      if (r.ecdsaOk && r.mldsaOk) okCount++;
    }
    yield {
      id: "signatures", state: okCount === batches.length ? "pass" : "fail",
      facts: { count: batches.length, ok: okCount, mldsaBytes, gas: gas.toString() },
      calls: [
        `ReadingLog BatchAnchored(passportId=${id}): ${batches.length} events`,
        "ReadingLog.batchDigest(...) per batch",
        "ecrecover(EIP-191(digest), ecdsaSig) == key.ecdsaSigner",
        "ML-DSA-44.Verify(pk from registerDevice calldata, digest, mldsaSig), keccak256(pk) == key.pkHash",
      ],
    };
  }

  // 3. model and 4. grade
  if (health.at === 0n) {
    yield { id: "model", state: "na", facts: {}, calls: [`PassportRegistry.health(${id})`] };
    yield { id: "grade", state: "na", facts: {}, calls: [`PassportRegistry.health(${id})`] };
  } else {
    const m = await getModel(health.modelId);
    const v = modelVerdict(m);
    yield {
      id: "model", state: v.ok ? "pass" : "fail",
      facts: { modelId: health.modelId, mae: m.maeBps, baseline: m.baselineMaeBps, coverage: m.coverageBps, active: m.active, uri: m.uri },
      calls: [`PassportRegistry.health(${id}).modelId`, `ModelRegistry.model(${health.modelId})`],
    };
    const onchain = await publicClient.readContract({ address: d.passportRegistry, abi: passportRegistryAbi, functionName: "gradeFor", args: [health.lowBps, health.highBps] });
    const local = gradeFor(health.lowBps, health.highBps);
    // the cited batch must be this passport's own
    let citedOk = false;
    try {
      const b = await publicClient.readContract({ address: d.readingLog, abi: readingLogAbi, functionName: "batch", args: [health.readingBatch] });
      citedOk = b.passportId === id && b.deviceId === passport.deviceId;
    } catch {
      citedOk = false;
    }
    yield {
      id: "grade", state: onchain === health.grade && local === health.grade && citedOk ? "pass" : "fail",
      facts: { low: health.lowBps, high: health.highBps, soh: health.sohBps, stored: health.grade, onchain, local, citedOk },
      calls: [`PassportRegistry.gradeFor(${health.lowBps}, ${health.highBps})`, `ReadingLog.batch(${health.readingBatch})`],
    };
  }

  // 5. conservation in the recycler batch
  if (passport.status !== 3 || passport.recyclerBatch === 0n) {
    yield { id: "conservation", state: "na", facts: { status: passport.status }, calls: [] };
  } else {
    const b = await getLedgerBatch(passport.recyclerBatch);
    const rows = conservationRows(b);
    const intakes = await publicClient.getContractEvents({
      address: d.conservationLedger, abi: conservationLedgerAbi, eventName: "Intake", args: { batchId: passport.recyclerBatch }, fromBlock: FROM_BLOCK,
    });
    const sums = [0n, 0n, 0n, 0n];
    for (const l of intakes) l.args.composition!.forEach((g, i) => (sums[i] += g));
    const inputMatches = sums.every((s, i) => s === b.input[i]);
    const ok = rows.every((r) => r.balanced && r.notesBalanced && r.underCeiling) && inputMatches;
    yield {
      id: "conservation", state: ok ? "pass" : "fail",
      facts: {
        batch: String(passport.recyclerBatch), passports: intakes.length, inputMatches,
        rows: JSON.stringify(rows.map((r) => [String(r.input), String(r.recovered), String(r.loss), String(r.pending), r.balanced])),
      },
      calls: [`ConservationLedger.batch(${passport.recyclerBatch})`, `ConservationLedger Intake(batchId=${passport.recyclerBatch}): ${intakes.length} events`],
    };
  }

  // 6. recycled content backed by spent nullifiers
  const added = await getRecycledEvents(id);
  const recordedAny = passport.recycled.some((g) => g > 0n);
  if (!added.length && !recordedAny) {
    yield { id: "nullifiers", state: "na", facts: { parent: String(passport.parentId) }, calls: [`PassportRegistry RecycledContentAdded(passportId=${id})`] };
  } else if (!added.length && passport.parentId !== 0n) {
    yield { id: "nullifiers", state: "pass", facts: { inherited: String(passport.parentId) }, calls: [`PassportRegistry.passport(${passport.parentId}).recycled`] };
  } else {
    const matches = recycledMatches(added.map((l) => ({ element: l.args.element!, grams: l.args.grams! })), passport.recycled);
    const spends = await publicClient.getContractEvents({ address: d.notePool, abi: notePoolAbi, eventName: "Spent", args: { passportId: id }, fromBlock: FROM_BLOCK });
    const nfs = spends.flatMap((s) => s.args.nullifiers!.filter((n) => n !== 0n));
    const spent = await Promise.all(nfs.map((n) => publicClient.readContract({ address: d.notePool, abi: notePoolAbi, functionName: "nullifierSpent", args: [n] })));
    const ok = matches.every(Boolean) && spent.every(Boolean) && spends.length === added.length;
    yield {
      id: "nullifiers", state: ok ? "pass" : "fail",
      facts: { spends: spends.length, nullifiers: nfs.length, allSpent: spent.every(Boolean), matches: matches.every(Boolean) },
      calls: [
        `PassportRegistry RecycledContentAdded(passportId=${id}): ${added.length} events`,
        `NotePool Spent(passportId=${id}): ${spends.length} events`,
        ...nfs.slice(0, 4).map((n) => `NotePool.nullifierSpent(0x${n.toString(16).slice(0, 10)}…) `),
      ],
    };
  }

  // 7. every note in the pool is backed by assayed metal from some ledger batch
  if (added.length) {
    const ev = await getNoteEvents();
    const minted = [0n, 0n, 0n, 0n];
    for (const m of ev.minted) minted[m.args.element!] += m.args.grams!;
    const n = Number(await ledgerBatchCount());
    const issued = [0n, 0n, 0n, 0n];
    const recovered = [0n, 0n, 0n, 0n];
    for (let i = 1; i <= n; i++) {
      const b = await getLedgerBatch(BigInt(i));
      for (let e = 0; e < 4; e++) {
        issued[e] += b.issued[e];
        recovered[e] += b.recovered[e];
      }
    }
    const ok = minted.every((m, e) => m === issued[e] && issued[e] <= recovered[e]);
    yield {
      id: "pool", state: ok ? "pass" : "fail",
      facts: { minted: minted.map(String).join(","), issued: issued.map(String).join(","), recovered: recovered.map(String).join(","), batches: n },
      calls: [`NotePool NoteMinted: ${ev.minted.length} events`, `ConservationLedger.batch(1..${n}).issued and .recovered`],
    };
  }
}

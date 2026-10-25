// Local store for one device, under gateway/data/<deviceId>/ (gitignored):
//
//   readings.jsonl   every sample, in the 49-byte wire form (SPEC.md 1.2)
//   batches.jsonl    every anchored batch with the wire readings it covers,
//                    so any reading's proof can be rebuilt later
//   state.json       index of the first reading not yet anchored
//
// Files are append-only except state.json, which is replaced atomically.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { fromWireHex, toWireHex, type Reading } from "../../lib/reading.ts";

export const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data");

export interface StoredBatch {
  seq: string;
  batchId: Hex;
  passportId: string;
  root: Hex;
  fromTs: string;
  toTs: string;
  count: number;
  digest: Hex;
  txHash: Hex;
  signer: "edge" | "gateway";
  wires: string[];
}

interface State {
  cursor: number;
}

export class Store {
  readonly dir: string;

  constructor(deviceId: Hex, root = process.env.KUTLE_DATA_DIR ?? DEFAULT_DATA_DIR) {
    this.dir = join(root, deviceId.toLowerCase().slice(0, 18));
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: string) {
    return join(this.dir, name);
  }

  private lines(name: string): string[] {
    const p = this.path(name);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
  }

  appendReading(r: Reading): void {
    appendFileSync(this.path("readings.jsonl"), JSON.stringify({ wire: toWireHex(r) }) + "\n");
  }

  readings(): Reading[] {
    return this.lines("readings.jsonl").map((l) => fromWireHex(JSON.parse(l).wire));
  }

  state(): State {
    const p = this.path("state.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { cursor: 0 };
  }

  setState(s: State): void {
    const p = this.path("state.json");
    writeFileSync(p + ".tmp", JSON.stringify(s) + "\n");
    renameSync(p + ".tmp", p);
  }

  /** Readings not yet anchored, with their absolute indices. */
  pending(): { start: number; readings: Reading[] } {
    const all = this.readings();
    const { cursor } = this.state();
    return { start: cursor, readings: all.slice(cursor) };
  }

  appendBatch(b: StoredBatch): void {
    appendFileSync(this.path("batches.jsonl"), JSON.stringify(b) + "\n");
  }

  batches(): StoredBatch[] {
    return this.lines("batches.jsonl").map((l) => JSON.parse(l));
  }
}

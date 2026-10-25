// Host side of the gateway-to-device line protocol (SPEC.md section 5).
//
// Two transports:
//   /dev/cu.usbmodemXXXX   the ESP32-S3 over USB CDC serial
//   sim:<path> [args]      the firmware's host build (firmware/sim), which runs
//                          the same protocol code over stdin/stdout
//
// Serial is opened through the file system after `stty` puts the port in raw
// mode, which avoids a native addon.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { openSync, closeSync, createReadStream, writeSync, type ReadStream } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";
import { toWireHex, type Reading } from "./reading.ts";

export interface Transport {
  write(line: string): void;
  onData(cb: (chunk: string) => void): void;
  close(): void;
}

class SerialTransport implements Transport {
  private fd: number;
  private rs: ReadStream;
  constructor(path: string) {
    const flag = process.platform === "darwin" ? "-f" : "-F";
    execFileSync("stty", [flag, path, "115200", "raw", "-echo", "-hupcl"]);
    this.fd = openSync(path, "r+");
    this.rs = createReadStream("", { fd: this.fd, autoClose: false, encoding: "utf8" });
  }
  write(line: string) {
    writeSync(this.fd, line);
  }
  onData(cb: (chunk: string) => void) {
    this.rs.on("data", (c) => cb(c as string));
  }
  close() {
    this.rs.destroy();
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

class ProcessTransport implements Transport {
  private child: ChildProcess;
  constructor(cmd: string[]) {
    this.child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
    this.child.stdout!.setEncoding("utf8");
  }
  write(line: string) {
    this.child.stdin!.write(line);
  }
  onData(cb: (chunk: string) => void) {
    this.child.stdout!.on("data", cb);
  }
  close() {
    this.child.stdin!.end();
    this.child.kill();
  }
}

export function openTransport(spec: string): Transport {
  if (spec.startsWith("sim:")) return new ProcessTransport(spec.slice(4).trim().split(/\s+/));
  return new SerialTransport(spec);
}

export interface SignedBatch {
  root: Hex;
  fromTs: bigint;
  toTs: bigint;
  count: number;
  digest: Hex;
  ecdsaSig: Hex;
  mldsaSig: Hex;
}

export interface Signature {
  digest: Hex;
  ecdsaSig: Hex;
  mldsaSig: Hex;
}

export interface DeviceId {
  address: Address;
  pkHash: Hex;
  commitment: Hex;
  locked: boolean;
}

const h32 = (v: bigint) => v.toString(16).padStart(64, "0");
const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
const hx = (s: string) => `0x${s}` as Hex;

export class EdgeClient {
  private buf = "";
  private waiters: ((line: string) => void)[] = [];
  private queue: string[] = [];
  private t: Transport;
  timeoutMs: number;

  constructor(t: Transport, timeoutMs = 60_000) {
    this.t = t;
    this.timeoutMs = timeoutMs;
    t.onData((chunk) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        if (line.length === 0) continue;
        if (line.startsWith("#")) {
          if (process.env.KUTLE_EDGE_DEBUG) console.error(`[device] ${line}`);
          continue;
        }
        const w = this.waiters.shift();
        if (w) w(line);
        else this.queue.push(line);
      }
    });
  }

  static open(spec: string): EdgeClient {
    return new EdgeClient(openTransport(spec));
  }

  private nextLine(): Promise<string> {
    const q = this.queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(done);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`device did not answer within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      const done = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiters.push(done);
    });
  }

  /** Send one command and return the words of its OK reply. */
  async request(line: string): Promise<string[]> {
    this.t.write(line + "\n");
    return this.expectOk();
  }

  private async expectOk(): Promise<string[]> {
    const reply = await this.nextLine();
    if (reply.startsWith("ERR")) throw new Error(`device: ${reply}`);
    if (!reply.startsWith("OK ")) throw new Error(`device sent an unexpected line: ${reply.slice(0, 120)}`);
    return reply.slice(3).split(" ");
  }

  async ping(): Promise<{ firmware: string; mode: string }> {
    const [, firmware, mode] = await this.request("PING");
    return { firmware, mode };
  }

  async id(): Promise<DeviceId> {
    const [, addr, pkHash, commitment, locked] = await this.request("ID");
    return { address: getAddress(hx(addr)), pkHash: hx(pkHash), commitment: hx(commitment), locked: locked === "1" };
  }

  async publicKey(): Promise<Uint8Array> {
    const [, pk] = await this.request("PK");
    return Uint8Array.from(Buffer.from(pk, "hex"));
  }

  async wrap(stationPub: Uint8Array): Promise<{ E: Uint8Array; ct: Uint8Array; tag: Uint8Array }> {
    const [, E, ct, tag] = await this.request(`WRAP ${Buffer.from(stationPub).toString("hex")}`);
    const b = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
    return { E: b(E), ct: b(ct), tag: b(tag) };
  }

  async lock(): Promise<void> {
    await this.request("LOCK");
  }

  async setTime(unix: number): Promise<void> {
    await this.request(`TIME ${unix}`);
  }

  async pop(chainId: bigint, registry: Address, deviceId: Hex, version: number): Promise<Signature> {
    const [, digest, e, m] = await this.request(`POP ${h32(chainId)} ${strip(registry)} ${strip(deviceId)} ${version}`);
    return { digest: hx(digest), ecdsaSig: hx(e), mldsaSig: hx(m) };
  }

  private parseBatch(w: string[]): SignedBatch {
    const [, root, fromTs, toTs, count, digest, e, m] = w;
    return {
      root: hx(root),
      fromTs: BigInt(fromTs),
      toTs: BigInt(toTs),
      count: Number(count),
      digest: hx(digest),
      ecdsaSig: hx(e),
      mldsaSig: hx(m),
    };
  }

  /** host-fed mode: send the raw readings; the device hashes them itself. */
  async signBatch(
    chainId: bigint,
    readingLog: Address,
    deviceId: Hex,
    passportId: bigint,
    seq: bigint,
    readings: readonly Reading[],
  ): Promise<SignedBatch> {
    await this.request(
      `BATCH ${h32(chainId)} ${strip(readingLog)} ${strip(deviceId)} ${h32(passportId)} ${seq} ${readings.length}`,
    );
    for (let i = 0; i < readings.length; i++) {
      const [, idx] = await this.request(`R ${toWireHex(readings[i])}`);
      if (Number(idx) !== i) throw new Error(`device acknowledged reading ${idx}, expected ${i}`);
    }
    return this.parseBatch(await this.expectOk());
  }

  /** smbus mode: take one gauge sample on the device. */
  async sample(): Promise<string> {
    const [, wire] = await this.request("SAMPLE");
    return wire;
  }

  /** smbus mode: sign the device's own buffered readings. Returns them too. */
  async ownBatch(
    chainId: bigint,
    readingLog: Address,
    deviceId: Hex,
    passportId: bigint,
    seq: bigint,
  ): Promise<{ wires: string[]; signed: SignedBatch }> {
    this.t.write(`OWNBATCH ${h32(chainId)} ${strip(readingLog)} ${strip(deviceId)} ${h32(passportId)} ${seq}\n`);
    const wires: string[] = [];
    for (;;) {
      const w = await this.expectOk();
      if (w[0] === "R") wires.push(w[1]);
      else if (w[0] === "BATCH") return { wires, signed: this.parseBatch(w) };
      else throw new Error(`unexpected reply to OWNBATCH: ${w[0]}`);
    }
  }

  async clear(count: number): Promise<number> {
    const [, remaining] = await this.request(`CLEAR ${count}`);
    return Number(remaining);
  }

  close(): void {
    this.t.close();
  }
}

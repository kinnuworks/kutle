import { describe, expect, it } from "vitest";
import { encodeErrorResult, type Hex } from "viem";
import { conservationAbi, kutleCouncilAbi, modelRegistryAbi, notePoolAbi, readingLogAbi, mldsaKeyAbi } from "../abi/index.ts";
import { decodeRevertData, errorIndex, formatDecoded, revertDataFrom, rootCause, errorMessage } from "./errors.ts";

describe("decodeRevertData", () => {
  it("decodes a library error and names every contract that declares it", () => {
    const data = encodeErrorResult({ abi: conservationAbi, errorName: "OverCeiling", args: [0] });
    const d = decodeRevertData(data);
    expect(d.name).toBe("OverCeiling");
    expect(d.args[0]).toMatchObject({ name: "element", value: "0" });
    expect(d.sources).toContain("Conservation");
  });

  it("decodes arguments of ReadingLog.BadSequence", () => {
    const d = decodeRevertData(encodeErrorResult({ abi: readingLogAbi, errorName: "BadSequence", args: [5n, 4n] }));
    expect(formatDecoded(d)).toBe("BadSequence(5, 4)");
  });

  it("decodes a large uint argument exactly", () => {
    const nf = 17839842267069912575588192087969802816561285156029183268805680796309414793040n;
    const d = decodeRevertData(encodeErrorResult({ abi: notePoolAbi, errorName: "NullifierUsed", args: [nf] }));
    expect(d.args[0].value).toBe(nf.toString());
  });

  it("follows a revert carried inside KutleCouncil.CallFailed(bytes)", () => {
    const inner = encodeErrorResult({ abi: modelRegistryAbi, errorName: "DoesNotBeatBaseline", args: [400, 320] });
    const outer = encodeErrorResult({ abi: kutleCouncilAbi, errorName: "CallFailed", args: [inner] });
    const d = decodeRevertData(outer);
    expect(d.name).toBe("CallFailed");
    expect(d.inner?.name).toBe("DoesNotBeatBaseline");
    expect(rootCause(d).args.map((a) => a.value)).toEqual(["400", "320"]);
    expect(formatDecoded(d)).toBe("CallFailed() -> DoesNotBeatBaseline(400, 320)");
  });

  it("knows the ML-DSA key floor error from the MLDSAKey library", () => {
    const d = decodeRevertData(encodeErrorResult({ abi: mldsaKeyAbi, errorName: "DegenerateKey", args: [3n] }));
    expect(d.name).toBe("DegenerateKey");
  });

  it("decodes Error(string) and handles empty and unknown data", () => {
    const err = decodeRevertData(
      "0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000046e6f706500000000000000000000000000000000000000000000000000000000",
    );
    expect(err.name).toBe("Error");
    expect(err.args[0].value).toBe("nope");
    expect(decodeRevertData("0x").name).toBe("empty revert");
    expect(decodeRevertData("0xdeadbeef").name).toBe("unknown error");
  });

  it("indexes errors from every system contract without selector clashes that change meaning", () => {
    for (const name of ["WrongNonce", "LabNotAccredited", "BadMldsaPoP", "KeyIsRevoked", "BatchNotForPassport", "SumcheckFailed", "Unbalanced"]) {
      expect([...errorIndex.values()].some((v) => v.item.name === name)).toBe(true);
    }
  });
});

describe("revertDataFrom", () => {
  it("walks the cause chain of a viem-shaped error", () => {
    const data = encodeErrorResult({ abi: readingLogAbi, errorName: "BadWindow" }) as Hex;
    const err = { shortMessage: "reverted", cause: { name: "ContractFunctionRevertedError", cause: { data } } };
    expect(revertDataFrom(err)).toBe(data);
    expect(errorMessage(err)).toBe("BadWindow()");
  });

  it("returns undefined when there is no revert data", () => {
    expect(revertDataFrom(new Error("network down"))).toBeUndefined();
    expect(errorMessage(new Error("network down"))).toBe("network down");
  });
});

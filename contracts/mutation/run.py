#!/usr/bin/env python3
"""Hand-written mutation testing for the rules that matter.

Each mutant breaks one rule in the source (drops a check, loosens a bound,
skips a signature). The suite must fail for every mutant. A mutant that
survives means a rule is not actually tested.

    python3 mutation/run.py            # from contracts/
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORGE = os.path.expanduser("~/.foundry/bin/forge")

MUTANTS = [
    ("conservation: balance as an inequality", "src/libraries/Conservation.sol",
     "if (recovered + loss + residual != pending)", "if (recovered + loss + residual > pending)"),
    ("conservation: no physical ceiling", "src/libraries/Conservation.sol",
     "if (recovered * BPS > processed * maxBps) revert OverCeiling(element);", ""),
    ("conservation: ceiling on pending instead of processed", "src/libraries/Conservation.sol",
     "if (recovered * BPS > processed * maxBps)", "if (recovered * BPS > pending * maxBps)"),
    ("ledger: no assay nonce", "src/ConservationLedger.sol",
     "if (a.nonce != b.assayCount) revert WrongNonce(b.assayCount, a.nonce);", ""),
    ("ledger: no lab accreditation", "src/ConservationLedger.sol",
     "if (!labs[a.lab].accredited) revert LabNotAccredited();", ""),
    ("ledger: recycler signature not checked", "src/ConservationLedger.sol",
     "if (!SignatureChecker.isValidSignatureNow(b.recycler, digest, recyclerSig)) revert BadRecyclerSignature();", ""),
    ("ledger: issue more than recovered", "src/ConservationLedger.sol",
     "if (total > b.issuable[element]) revert OverIssuable(element);", "if (total > b.issuable[element] + 1_000_000) revert OverIssuable(element);"),
    ("ledger: taint ignored by settle", "src/ConservationLedger.sol",
     "        if (b.tainted) revert BatchTainted();\n        if (block.timestamp > a.deadline)", "        if (block.timestamp > a.deadline)"),
    ("ledger: no deadline", "src/ConservationLedger.sol",
     "if (block.timestamp > a.deadline) revert Expired();", ""),
    ("passports: closing does not change status", "src/PassportRegistry.sol",
     "        s.status = RECYCLED;\n", ""),
    ("passports: recycled content above composition", "src/PassportRegistry.sol",
     "if (total > s.composition[element]) revert ExceedsComposition(element);", ""),
    ("passports: wide interval still grades", "src/PassportRegistry.sol",
     "if (highBps - lowBps > MAX_INTERVAL_BPS) return GRADE_BENCH_TEST;", ""),
    ("passports: grade may cite any batch", "src/PassportRegistry.sol",
     "if (b.passportId != passportId || b.deviceId != s.deviceId) revert BatchNotForPassport();", ""),
    ("notes: nullifier reuse allowed", "src/NotePool.sol",
     "if (nullifierSpent[nf]) revert NullifierUsed(nf);", ""),
    ("notes: duplicate nullifier in one spend", "src/NotePool.sol",
     "if (nullifiers[j] == nf) revert DuplicateNullifier();", ""),
    ("notes: binding left out of public inputs", "src/NotePool.sol",
     "pub[9] = bytes32(binding);", "pub[9] = bytes32(0);"),
    ("devices: ML-DSA result ignored", "src/DeviceRegistry.sol",
     "if (!_mldsaOk(k, digest, mldsaSig)) revert BadMldsaPoP();", "_mldsaOk(k, digest, mldsaSig);"),
    ("devices: no degeneracy floor", "src/libraries/MLDSAKey.sol",
     "if (big < MIN_LARGE) revert DegenerateKey(big);", ""),
    ("readings: no sequence check", "src/ReadingLog.sol",
     "if (seq != expected) revert BadSequence(expected, seq);", ""),
    ("readings: device not bound to passport", "src/ReadingLog.sol",
     "if (passports.deviceOf(passportId) != deviceId) revert WrongDevice();", ""),
]


def run_suite():
    env = dict(os.environ, FOUNDRY_OUT="out-mut", FOUNDRY_CACHE_PATH="cache-mut", FOUNDRY_INVARIANT_RUNS="32")
    r = subprocess.run([FORGE, "test"], cwd=ROOT, env=env, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def main():
    code, out = run_suite()
    if code != 0:
        print("baseline suite fails; fix it before mutation testing")
        print(out[-2000:])
        sys.exit(1)

    results = []
    for name, rel, old, new in MUTANTS:
        path = ROOT / rel
        src = path.read_text()
        if src.count(old) != 1:
            results.append({"mutant": name, "status": "not applied (pattern not unique)"})
            continue
        path.write_text(src.replace(old, new))
        t = time.time()
        try:
            code, out = run_suite()
        finally:
            path.write_text(src)
        killed = code != 0
        compile_error = "Compiler run failed" in out
        status = "killed" if killed and not compile_error else ("compile error" if compile_error else "SURVIVED")
        results.append({"mutant": name, "file": rel, "status": status, "seconds": round(time.time() - t, 1)})
        print(f"{status:14} {name}")

    killed = sum(1 for r in results if r["status"] == "killed")
    (ROOT / "mutation" / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"\n{killed} of {len(results)} mutants killed")
    sys.exit(0 if killed == len(results) else 1)


if __name__ == "__main__":
    main()

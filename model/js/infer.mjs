// Pure JavaScript inference for the Kutle battery health methods.
//
// Mirrors model/kutle_health/inference.py. No dependencies. Only additions,
// subtractions, multiplications, divisions and comparisons are used, so the
// output matches the Python version exactly for the same files and inputs.
//
//   infer(model, inputs)            learned model (artifacts/model.json)
//   measuredInfer(params, inputs)   measured-capacity method (artifacts/measured_method.json)
//   combined(model, params, inputs) deployed grader: measured-fresh or BENCH_TEST, tamper flag
//
// Command line: reads a JSON array of input objects on stdin, writes a JSON
// array of combined results:
//   node infer.mjs ../artifacts/model.json ../artifacts/measured_fresh_method.json < inputs.json

export const GRADE_REUSE = 1;
export const GRADE_REPURPOSE = 2;
export const GRADE_BENCH_TEST = 3;
export const GRADE_RECYCLE = 4;
export const GRADE_NAMES = { 1: "REUSE", 2: "REPURPOSE", 3: "BENCH_TEST", 4: "RECYCLE" };

const REUSE_FLOOR_BPS = 8000;
const REPURPOSE_FLOOR_BPS = 6000;
const MAX_INTERVAL_BPS = 1000;
const SOH_MAX = 1.2;

// Same rule as PassportRegistry.gradeFor.
export function gradeFor(lowBps, highBps) {
  if (highBps < REPURPOSE_FLOOR_BPS) return GRADE_RECYCLE;
  if (highBps - lowBps > MAX_INTERVAL_BPS) return GRADE_BENCH_TEST;
  if (lowBps >= REUSE_FLOOR_BPS) return GRADE_REUSE;
  if (lowBps >= REPURPOSE_FLOOR_BPS) return GRADE_REPURPOSE;
  return GRADE_BENCH_TEST;
}

function missing(x) {
  return x === null || x === undefined || (typeof x === "number" && Number.isNaN(x));
}

function treeValue(tree, row) {
  const { f, t, m, l, r, v } = tree;
  let i = 0;
  while (f[i] !== -1) {
    const x = row[f[i]];
    if (x === null) {
      i = m[i] === 1 ? l[i] : r[i];
    } else if (x <= t[i]) {
      i = l[i];
    } else {
      i = r[i];
    }
  }
  return v[i];
}

function raw(gbm, row) {
  let acc = gbm.baseline;
  for (const tree of gbm.trees) acc = acc + treeValue(tree, row);
  return acc;
}

function round(x) {
  return Math.floor(x + 0.5);
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function presentGroups(model, inputs) {
  const out = [];
  for (const g of model.group_order) {
    if (model.groups[g].every((name) => !missing(inputs[name]))) out.push(g);
  }
  return out;
}

function halfWidth(interval, q, rawValue) {
  if (interval.kind === "relative") {
    let s = 1.0 - rawValue;
    if (s < interval.floor) s = interval.floor;
    return q * s;
  }
  return q;
}

function part(model, key, inputs, present) {
  const p = model.models[key];
  const feats = p.features;
  const used = model.group_order.filter(
    (g) => present.includes(g) && model.groups[g].some((n) => feats.includes(n)),
  );
  const missingNames = new Set();
  for (const g of model.group_order) {
    if (!present.includes(g)) for (const n of model.groups[g]) missingNames.add(n);
  }
  const row = feats.map((name) => {
    const x = inputs[name];
    return missingNames.has(name) || missing(x) ? null : Number(x);
  });
  const pattern = used.length ? used.join("+") : "none";
  const ood = [];
  feats.forEach((name, j) => {
    const x = row[j];
    if (x === null) return;
    const rng = model.train_range[name];
    if (rng !== undefined && rng !== null && (x < rng[0] || x > rng[1])) ood.push(name);
  });
  const r = raw(p.gbm, row);
  const hw = halfWidth(p.interval, p.interval.q[pattern], r);
  return { raw: r, hw, pattern, ood };
}

export function infer(model, inputsIn) {
  const inputs = { ...inputsIn };
  const present = presentGroups(model, inputs);

  const s = part(model, "soh", inputs, present);
  const soh = s.raw;
  const loBps = round(clamp(soh - s.hw, 0.0, SOH_MAX) * 10000.0);
  const hiBps = round(clamp(soh + s.hw, 0.0, SOH_MAX) * 10000.0);

  let sohSource = "measured";
  if (missing(inputs.soh_now)) {
    inputs.soh_now = soh;
    sohSource = "model";
  }
  let cyc = inputs[model.counter];
  cyc = missing(cyc) || cyc < 1.0 ? 1.0 : Number(cyc);
  inputs.fade_life = ((1.0 - inputs.soh_now) * 100.0) / cyc;
  const presentRul = presentGroups(model, inputs);

  const out = {
    soh,
    soh_bps: round(clamp(soh, 0.0, SOH_MAX) * 10000.0),
    soh_low_bps: loBps,
    soh_high_bps: hiBps,
    soh_pattern: s.pattern,
    soh_ood: s.ood,
    soh_now_source: sohSource,
    grade: gradeFor(loBps, hiBps),
  };
  for (const [key, threshold] of [["rul80", 0.8], ["rul60", 0.6]]) {
    const r = part(model, key, inputs, presentRul);
    if (inputs.soh_now < threshold) {
      out[key] = 0;
      out[key + "_low"] = 0;
      out[key + "_high"] = 0;
    } else {
      const root = r.raw > 0.0 ? r.raw : 0.0;
      let loRoot = r.raw - r.hw;
      loRoot = loRoot > 0.0 ? loRoot : 0.0;
      const hiRoot = r.raw + r.hw;
      out[key] = round(root * root);
      out[key + "_low"] = round(loRoot * loRoot);
      out[key + "_high"] = round(hiRoot * hiRoot);
    }
    out[key + "_raw"] = r.raw;
    out[key + "_pattern"] = r.pattern;
    out[key + "_ood"] = r.ood;
  }
  out.grade_name = GRADE_NAMES[out.grade];
  return out;
}

export function measuredInfer(params, inputs) {
  const sm = Number(inputs.soh_measured);
  let n = inputs.cycles_since_update;
  n = missing(n) || n < 0.0 ? 0.0 : Number(n);
  const point = sm - n * params.fade_median_per_cycle;
  const low = sm - params.accuracy - n * params.fade_p90_per_cycle;
  const high = sm + params.accuracy;
  const loBps = round(clamp(low, 0.0, SOH_MAX) * 10000.0);
  const hiBps = round(clamp(high, 0.0, SOH_MAX) * 10000.0);
  const g = gradeFor(loBps, hiBps);
  return {
    soh_bps: round(clamp(point, 0.0, SOH_MAX) * 10000.0),
    soh_low_bps: loBps,
    soh_high_bps: hiBps,
    measured_bps: round(clamp(sm, 0.0, SOH_MAX) * 10000.0),
    cycles_since_update: n,
    fresh: n <= params.fresh_cycles,
    grade: g,
    grade_name: GRADE_NAMES[g],
  };
}

// The deployed grader; see combined() in inference.py for the rules.
export function combined(model, params, inputs) {
  const learnedInputs = { ...inputs };
  delete learnedInputs.soh_measured;
  delete learnedInputs.cycles_since_update;
  const hasMeasured = !missing(inputs.soh_measured);
  if (hasMeasured && missing(learnedInputs.soh_now)) learnedInputs.soh_now = inputs.soh_measured;
  const learned = infer(model, learnedInputs);
  const meas = hasMeasured ? measuredInfer(params, inputs) : null;
  const tamper = meas === null ? null : meas.measured_bps > learned.soh_high_bps;
  let source, sohBps, low, high;
  if (meas !== null && meas.fresh && !tamper) {
    source = "measured_fresh";
    sohBps = meas.soh_bps;
    low = meas.soh_low_bps;
    high = meas.soh_high_bps;
  } else {
    source = "not_graded";
    sohBps = meas !== null ? meas.soh_bps : learned.soh_bps;
    low = 0;
    high = round(SOH_MAX * 10000.0);
  }
  const g = gradeFor(low, high);
  return {
    learned,
    measured: meas,
    tamper_flag: tamper,
    source,
    submission: {
      modelId: params.model_id,
      sohBps,
      lowBps: low,
      highBps: high,
      rulCycles: learned.rul80,
      grade: g,
      grade_name: GRADE_NAMES[g],
    },
  };
}

// Command line entry point.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const fs = await import("node:fs");
  const model = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const params = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const inputs = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(inputs.map((x) => combined(model, params, x))) + "\n");
}

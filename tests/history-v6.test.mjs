import assert from "node:assert/strict";
import test from "node:test";
import { V6_HISTORY_KEY, candidatesFromRecord, dedupeRecords, readV6History, recordFromScan, removeRecord } from "../app/lib/history-v6.mjs";

const finalCandidate = {
  rank: 1,
  finalRank: 1,
  role: "首选",
  code: "600001",
  name: "测试股份",
  currentPrice: 10,
  strength: 82,
  tradeability: 79,
  dataConfidence: 95,
  decisionScore: 83,
  tradePlan: { status: "BUYABLE", entryLow: 9.95, entryHigh: 10.05, stop: 9.7, target1: 10.9, netRR: 2.1, executable: true },
  decisionExplanation: { whySelected: ["强度达标", "交易性达标", "账户可执行"] },
};

const scan = {
  strategyVersion: "6.0.1",
  scanTime: "2026-08-08T08:00:00.000Z",
  mode: "EOD",
  marketPhase: "POST_CLOSE",
  marketPhaseLabel: "收盘后",
  universeCoverage: { expectedUniverse: 5200, fetchedSymbols: 5200, uniqueSymbols: 5200, coverageRatio: 1, pageCount: 6, truncated: false },
  dataHealth: { status: "OK", scanTime: "2026-08-08T08:00:00.000Z", warnings: [] },
  funnel: { universe: 5200, validData: 5100, eligible: 3600, scored: 3600, radar: 20, executablePool: 4, final: 1 },
  finalCandidates: [finalCandidate],
  internalRadar: [finalCandidate, { ...finalCandidate, rank: 2, code: "600002", name: "研究股份" }],
};

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    dump: () => Object.fromEntries(values),
  };
}

test("History Test 1: unrelated old storage does not enter the V6 Journal", () => {
  const state = storage({ "cts-selection-history": JSON.stringify([{ code: "600001" }]), [V6_HISTORY_KEY]: "[]" });
  assert.deepEqual(readV6History(state), []);
  assert.deepEqual(state.dump(), { "cts-selection-history": JSON.stringify([{ code: "600001" }]), [V6_HISTORY_KEY]: "[]" });
});

test("History Test 2: an explicit V6.0.1 save stores the full decision snapshot", () => {
  const record = recordFromScan(scan);
  assert.equal(record.schemaVersion, "v6");
  assert.equal(record.strategyVersion, "6.0.1");
  assert.equal(record.scanTime, scan.scanTime);
  assert.equal(record.finalCandidates.length, 1);
  assert.equal(record.tradePlans[0].tradePlan, finalCandidate.tradePlan);
  assert.equal(record.decisionExplanations[0].decisionExplanation, finalCandidate.decisionExplanation);
  assert.equal(record.internalRadar.length, 2);
  assert.deepEqual(record.coverage, scan.universeCoverage);
});

test("History Test 3: saving the same scan twice does not duplicate it", () => {
  const first = recordFromScan(scan);
  const second = recordFromScan(scan);
  assert.equal(dedupeRecords([first, second]).length, 1);
});

test("History Test 4: an explicitly saved zero-candidate decision is valid", () => {
  const record = recordFromScan({ ...scan, finalCandidates: [] });
  assert.equal(dedupeRecords([record]).length, 1);
  assert.deepEqual(candidatesFromRecord(record), []);
});

test("History Test 5: an explicit second scan creates a second record", () => {
  const first = recordFromScan(scan);
  const second = recordFromScan({ ...scan, scanTime: "2026-08-08T08:01:00.000Z" });
  assert.equal(dedupeRecords([first, second]).length, 2);
});

test("History Test 6: V6 records survive a reload", () => {
  const state = storage({ [V6_HISTORY_KEY]: JSON.stringify([recordFromScan(scan)]) });
  assert.equal(readV6History(state).length, 1);
});

test("History Test 7: deleting one V6 record leaves the other", () => {
  const first = recordFromScan(scan);
  const second = recordFromScan({ ...scan, scanTime: "2026-08-08T08:01:00.000Z" });
  assert.equal(removeRecord([first, second], first.id).length, 1);
});

test("History Test 8: a stored 6.0.0 snapshot is preserved without recomputation", () => {
  const legacySnapshot = {
    id: "v6-old",
    schemaVersion: "v6",
    strategyVersion: "6.0.0",
    mode: "EOD",
    scanTime: "2026-08-07T08:00:00.000Z",
    candidates: [{ code: "600009", name: "旧快照", price: 9.8, plan: { stop: 9.4, target: 10.6 } }],
  };
  const state = storage({ [V6_HISTORY_KEY]: JSON.stringify([legacySnapshot]) });
  const loaded = readV6History(state);
  assert.deepEqual(loaded[0], legacySnapshot);
  assert.deepEqual(candidatesFromRecord(loaded[0]), legacySnapshot.candidates);
});

test("History Test 9: V5 records are ignored and their source key is untouched", () => {
  const v5 = { schemaVersion: "v5", strategyVersion: "5.0.0", mode: "EOD", scanTime: scan.scanTime, candidates: [{ code: "600001" }] };
  const rawV5 = JSON.stringify([v5]);
  const state = storage({ "cts-selection-history": rawV5, [V6_HISTORY_KEY]: JSON.stringify([v5]) });
  assert.deepEqual(readV6History(state), []);
  assert.equal(state.dump()["cts-selection-history"], rawV5);
});

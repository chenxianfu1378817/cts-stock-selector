import assert from "node:assert/strict";
import test from "node:test";
import { STRATEGY_V6 } from "../app/lib/strategy-v6.config.mjs";
import { coverageStatus, fetchPaginatedUniverse, mergeUniverseResults, rebaseUniverseCoverage } from "../app/lib/universe-coverage.mjs";
import { buildTradePlan, createPercentileRanker, marketPhaseAt, percentileRank, selectFinalCandidates, sortRadar, validateTradePlanMath } from "../app/lib/strategy-v6.mjs";

const baseCandidate = {
  code: "600001",
  name: "测试股份",
  currentPrice: 10,
  auctionIndicativePrice: null,
  high: 10.5,
  low: 9.7,
  high20: 12,
  ma5: 10,
  ma10: 9.6,
  ma20: 9.2,
  change: 1,
  position: 0.5,
  amount: 1_000_000_000,
  ret5: 8,
  ret20: 15,
  ratio: 1.5,
  sector: "测试行业",
  missingFactors: [],
};

const factor = (key, label, score) => ({ key, label, score, available: true });
const strengthParts = [factor("market", "Market", 90), factor("sector", "Sector", 88), factor("relativeStrength", "Relative Strength", 92), factor("trend", "Trend", 86), factor("volumePrice", "Volume Price", 84), factor("activity", "Activity", 82), factor("priceQuality", "Price Quality", 80)];
const tradeParts = [factor("entryLocation", "Entry Location", 86), factor("riskReward", "Risk Reward", 90), factor("stopQuality", "Stop Quality", 82), factor("chaseRisk", "Chase Risk", 88), factor("t1GapRisk", "T+1 Risk", 78), factor("accountExecution", "Account Execution", 100)];

function qualifyingCandidate(code, overrides = {}) {
  const tradePlan = {
    status: "BUYABLE",
    entryType: "CURRENT",
    entryLow: 9.97,
    entryHigh: 10.03,
    referenceEntry: 10,
    stop: 9.7,
    target1: 11,
    target2: null,
    grossRR: 3.33,
    netRR: 2.4,
    quantity: 200,
    capitalRequired: 2010,
    estimatedFees: 12,
    maxLoss: 72,
    executable: true,
    tradePlanValid: true,
    failedGates: [],
    currentTradeability: 85,
    projectedTradeability: null,
    effectiveTradeability: 85,
    tradeabilityParts: tradeParts,
    waitingReason: null,
    upgradeTrigger: null,
    invalidation: "跌破9.70失效",
    severeFlags: [],
    ...overrides.tradePlan,
  };
  return {
    ...baseCandidate,
    code,
    name: `候选${code}`,
    strength: 88,
    tradeability: tradePlan.currentTradeability,
    dataConfidence: 100,
    factorScores: { strength: strengthParts, tradeability: tradeParts },
    tradePlan,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "tradePlan")),
  };
}

test("Test 1: Wen-Cai 2000-row first page continues to all pages", async () => {
  const calls = [];
  const result = await fetchPaginatedUniverse(async (page) => {
    calls.push(page);
    const start = (page - 1) * 2000;
    const length = page < 3 ? 2000 : 1200;
    return { count: 5200, rows: Array.from({ length }, (_, index) => ({ code: String(start + index).padStart(6, "0") })) };
  }, { pageSize: 2000, symbolFrom: (row) => row.code });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(result.coverage.uniqueSymbols, 5200);
  assert.equal(result.coverage.pageCount, 3);
  assert.equal(result.coverage.truncated, false);
});

test("Test 2: 2000 of 5200 coverage cannot be OK", () => {
  const detailed = { rows: Array(2000), coverage: { expectedUniverse: 2000, fetchedSymbols: 2000, uniqueSymbols: 2000, coverageRatio: 1, pageCount: 1, truncated: false, providerLimitDetected: false } };
  const rebased = rebaseUniverseCoverage(detailed, 5200);
  assert.equal(rebased.coverage.expectedUniverse, 5200);
  assert.equal(coverageStatus(rebased.coverage), "ERROR");
});

test("Test 2a: suspicious 2939 of 2939 cannot claim full-market OK", () => {
  assert.equal(coverageStatus({ expectedUniverse: 2939, coverageRatio: 1, truncated: false }), "ERROR");
});

test("Test 2b: exchange partitions merge without overlaps or omissions", () => {
  const merged = mergeUniverseResults([
    { rows: [{ code: "600001" }, { code: "688001" }], coverage: { expectedUniverse: 2, fetchedSymbols: 2, uniqueSymbols: 2, pageCount: 1, truncated: false, providerLimitDetected: false } },
    { rows: [{ code: "000001" }, { code: "300001" }], coverage: { expectedUniverse: 2, fetchedSymbols: 2, uniqueSymbols: 2, pageCount: 1, truncated: false, providerLimitDetected: false } },
  ], (row) => row.code);
  assert.equal(merged.coverage.expectedUniverse, 4);
  assert.equal(merged.coverage.uniqueSymbols, 4);
  assert.equal(merged.coverage.coverageRatio, 1);
});

test("Test 3: Radar sorting is Strength DESC and transitive", () => {
  const sorted = sortRadar([{ code: "A", strength: 95, tradeability: 10 }, { code: "B", strength: 91, tradeability: 100 }, { code: "C", strength: 94, tradeability: 80 }]);
  assert.deepEqual(sorted.map((item) => item.code), ["A", "C", "B"]);
});

test("Test 3a: binary percentile ranker is identical to the original definition", () => {
  const universe = [8, 2, 4, 4, 10, 1];
  const rank = createPercentileRanker(universe);
  for (const value of [1, 4, 5, 10]) assert.equal(rank(value), percentileRank(value, universe));
});

test("Test 4: entry below stop is INVALID", () => {
  assert.ok(validateTradePlanMath({ referenceEntry: 121.58, stop: 122.37, target1: 130, grossRR: 1, executable: false }).includes("STOP_INVALID"));
});

test("Test 5: target below entry is INVALID", () => {
  assert.ok(validateTradePlanMath({ referenceEntry: 121.58, stop: 120, target1: 121, grossRR: -1, executable: false }).includes("TARGET_INVALID"));
});

test("Test 6: low RR requires a fully recalculated trigger plan", () => {
  const plan = buildTradePlan({ ...baseCandidate, currentPrice: 12, high: 12.2, low: 9.7, ma5: 10, high20: 13 }, { marketPhase: "CONTINUOUS_AM", account: STRATEGY_V6.account });
  assert.equal(plan.status, "WAIT_TRIGGER");
  assert.ok(plan.projectedTradeability >= 75);
  assert.ok(plan.netRR >= 1.8);
  assert.match(plan.upgradeTrigger, /净盈亏比.*Projected Tradeability/);
});

test("Test 7: no valid upgrade price reports no valid trigger", () => {
  const plan = buildTradePlan({ ...baseCandidate, high20: 10.05, ma5: 9.95, ma10: 9.9 }, { marketPhase: "POST_CLOSE", account: STRATEGY_V6.account });
  assert.equal(plan.status, "WATCH_ONLY");
  assert.equal(plan.upgradeTrigger, "暂无有效A级升级触发条件。");
});

test("Test 8: price below MA5 never says pull back to MA5", () => {
  const plan = buildTradePlan({ ...baseCandidate, currentPrice: 9.8, ma5: 10, low: 9.5, high20: 11.5 }, { marketPhase: "POST_CLOSE", account: STRATEGY_V6.account });
  assert.doesNotMatch(plan.upgradeTrigger || "", /回踩MA5/);
});

test("Test 9: account cannot buy 100 shares stays out of Final", () => {
  const expensive = qualifyingCandidate("600009", { currentPrice: 130, tradePlan: { executable: false, quantity: 0, capitalRequired: null, netRR: null, effectiveTradeability: 90, currentTradeability: 90 } });
  assert.equal(selectFinalCandidates([expensive], "OK").length, 0);
});

test("Test 10: one qualifying candidate returns one only", () => {
  assert.equal(selectFinalCandidates([qualifyingCandidate("600001")], "OK").length, 1);
});

test("Test 11: zero qualifying candidates does not pad output", () => {
  assert.equal(selectFinalCandidates([qualifyingCandidate("600001", { strength: 60 })], "OK").length, 0);
});

test("Test 12: more than three qualifying candidates returns top three", () => {
  const candidates = [1, 2, 3, 4].map((index) => qualifyingCandidate(`60000${index}`, { strength: 90 - index }));
  const final = selectFinalCandidates(candidates, "OK");
  assert.equal(final.length, 3);
  assert.deepEqual(final.map((item) => item.code), ["600001", "600002", "600003"]);
});

test("Test 13: 09:20 is auction watch and never BUYABLE", () => {
  const phase = marketPhaseAt(new Date("2026-08-10T09:20:00+08:00"));
  const plan = buildTradePlan({ ...baseCandidate, auctionIndicativePrice: 10 }, { marketPhase: phase, account: STRATEGY_V6.account });
  assert.equal(phase, "OPEN_AUCTION");
  assert.notEqual(plan.status, "BUYABLE");
  assert.equal(plan.status, "AUCTION_WATCH");
});

test("Test 14: 09:27 waits for continuous trading", () => {
  const phase = marketPhaseAt(new Date("2026-08-10T09:27:00+08:00"));
  const plan = buildTradePlan(baseCandidate, { marketPhase: phase, account: STRATEGY_V6.account });
  assert.equal(phase, "WAIT_OPEN");
  assert.equal(plan.status, "WAIT_OPEN");
});

test("Test 15: 09:35 may produce BUYABLE", () => {
  const phase = marketPhaseAt(new Date("2026-08-10T09:35:00+08:00"));
  const plan = buildTradePlan(baseCandidate, { marketPhase: phase, account: STRATEGY_V6.account });
  assert.equal(phase, "CONTINUOUS_AM");
  assert.equal(plan.status, "BUYABLE");
});

test("Test 16: limit-up risk is flagged and excluded from Final", () => {
  const plan = buildTradePlan({ ...baseCandidate, change: 9.9 }, { marketPhase: "CONTINUOUS_AM", account: STRATEGY_V6.account });
  assert.ok(plan.severeFlags.includes("LIMIT_UP_RISK"));
  const candidate = qualifyingCandidate("600008", { tradePlan: { severeFlags: ["LIMIT_UP_RISK", "FILL_PROBABILITY_LOW"] } });
  assert.equal(selectFinalCandidates([candidate], "OK").length, 0);
});

test("Test 16b: BUYABLE with any unresolved Gate is excluded from Final", () => {
  const candidate = qualifyingCandidate("600010", { tradePlan: { failedGates: ["ENTRY_TOO_FAR"] } });
  assert.equal(selectFinalCandidates([candidate], "OK").length, 0);
});

test("Test 17: every Final candidate has detailed non-circular explanation", () => {
  const [candidate] = selectFinalCandidates([qualifyingCandidate("600001")], "OK");
  assert.equal(candidate.decisionExplanation.whySelected.length, 3);
  assert.equal(candidate.decisionExplanation.weakFactors.length, 2);
  assert.ok(candidate.decisionExplanation.whyRankedHere);
  assert.ok(candidate.decisionExplanation.currentDecision);
  assert.ok(candidate.decisionExplanation.invalidationLogic);
  assert.ok(candidate.decisionExplanation.accountLogic);
  assert.doesNotMatch(JSON.stringify(candidate.decisionExplanation), /Strength高，因为Strength高/);
});

test("Market phase state machine covers lunch, close auction, post-close and weekend", () => {
  assert.equal(marketPhaseAt(new Date("2026-08-10T12:00:00+08:00")), "LUNCH_BREAK");
  assert.equal(marketPhaseAt(new Date("2026-08-10T14:58:00+08:00")), "CLOSE_AUCTION");
  assert.equal(marketPhaseAt(new Date("2026-08-10T15:10:00+08:00")), "POST_CLOSE");
  assert.equal(marketPhaseAt(new Date("2026-08-09T10:00:00+08:00")), "NON_TRADING_DAY");
});

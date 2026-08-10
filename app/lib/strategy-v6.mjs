import { STRATEGY_V6 } from "./strategy-v6.config.mjs";

export const clampScore = (value) => Number.isFinite(value) ? Math.max(0, Math.min(100, Number(value))) : 0;
const round2 = (value) => Number.isFinite(value) ? Math.round(Number(value) * 100) / 100 : null;
const round1 = (value) => Math.round(Number(value) * 10) / 10;

export function percentileRank(value, universe) {
  return value == null || !Number.isFinite(value) || universe.length === 0
    ? null
    : clampScore(universe.filter((item) => item <= value).length / universe.length * 100);
}

export function createPercentileRanker(universe) {
  const sorted = (universe || []).filter(Number.isFinite).sort((a, b) => a - b);
  return (value) => {
    if (value == null || !Number.isFinite(value) || sorted.length === 0) return null;
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle] <= value) low = middle + 1;
      else high = middle;
    }
    return clampScore(low / sorted.length * 100);
  };
}

export function weightedScore(parts, weights) {
  const available = parts.filter((part) => part.available && part.score != null);
  const activeWeight = available.reduce((total, part) => total + (weights[part.key] || 0), 0);
  return {
    score: activeWeight === 0 ? 0 : clampScore(available.reduce((total, part) => total + clampScore(part.score) * (weights[part.key] || 0) / activeWeight, 0)),
    missing: parts.filter((part) => !part.available || part.score == null).map((part) => part.key),
  };
}

export function rrScore(rr) {
  if (rr == null || !Number.isFinite(rr)) return null;
  if (rr < 1) return 10;
  if (rr < 1.5) return 30;
  if (rr < 1.8) return 48;
  if (rr < 2.2) return 65;
  if (rr < 2.5) return 82;
  return 100;
}

export function eligibility({ code, name, price, suspended = false }) {
  if (!code || !name || price == null || price <= 0) return "invalidQuote";
  if (!/^(00|30|60|68)/.test(code) || /(B股|ETF|LOF|基金|转债|可转债)/i.test(name)) return "notCommonAshare";
  if (/(ST|\*ST|退市)/i.test(name)) return "riskWarning";
  if (suspended) return "suspended";
  return "eligible";
}

export function sortRadar(items) {
  return [...items].sort((a, b) => {
    const strengthDelta = round1(b.strength) - round1(a.strength);
    if (strengthDelta !== 0) return strengthDelta;
    const tradeabilityDelta = round1(b.tradeability) - round1(a.tradeability);
    if (tradeabilityDelta !== 0) return tradeabilityDelta;
    return String(a.code || a.symbol || "").localeCompare(String(b.code || b.symbol || ""));
  });
}

export function marketPhaseAt(now = new Date(), options = {}) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  const weekday = value("weekday");
  const isWeekday = ["周一", "周二", "周三", "周四", "周五"].includes(weekday);
  const isTradingDay = options.isTradingDay ?? isWeekday;
  if (!isTradingDay) return "NON_TRADING_DAY";
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  if (minutes < 9 * 60 + 15) return "PREOPEN";
  if (minutes < 9 * 60 + 25) return "OPEN_AUCTION";
  if (minutes < 9 * 60 + 30) return "WAIT_OPEN";
  if (minutes < 11 * 60 + 30) return "CONTINUOUS_AM";
  if (minutes < 13 * 60) return "LUNCH_BREAK";
  if (minutes < 14 * 60 + 57) return "CONTINUOUS_PM";
  if (minutes < 15 * 60) return "CLOSE_AUCTION";
  return "POST_CLOSE";
}

export const MARKET_PHASE_LABELS = Object.freeze({
  PREOPEN: "盘前准备",
  OPEN_AUCTION: "集合竞价",
  WAIT_OPEN: "竞价结束，等待开盘",
  CONTINUOUS_AM: "连续竞价（上午）",
  LUNCH_BREAK: "午间休市",
  CONTINUOUS_PM: "连续竞价（下午）",
  CLOSE_AUCTION: "收盘集合竞价",
  POST_CLOSE: "收盘后",
  NON_TRADING_DAY: "非交易日",
});

export const phaseAllowsBuy = (phase) => phase === "CONTINUOUS_AM" || phase === "CONTINUOUS_PM";

function tradingCosts(entry, exit, quantity, account) {
  if (!quantity) return { buyFees: null, sellFees: null, slippage: null, total: null };
  const buyValue = entry * quantity;
  const sellValue = exit * quantity;
  const buyCommission = Math.max(account.minCommission, buyValue * account.commissionRate);
  const sellCommission = Math.max(account.minCommission, sellValue * account.commissionRate);
  const stampTax = sellValue * account.stampTaxRate;
  const slippage = (buyValue + sellValue) * account.slippagePct;
  return {
    buyFees: round2(buyCommission + buyValue * account.slippagePct),
    sellFees: round2(sellCommission + stampTax + sellValue * account.slippagePct),
    slippage: round2(slippage),
    total: round2(buyCommission + sellCommission + stampTax + slippage),
  };
}

function structuralStop(candidate, entry) {
  const levels = [
    candidate.low != null && candidate.low < entry ? candidate.low * 0.995 : null,
    candidate.ma10 != null && candidate.ma10 < entry ? candidate.ma10 * 0.99 : null,
    entry * 0.94,
  ].filter((value) => value != null && value > 0 && value < entry);
  return levels.length ? Math.max(...levels) : null;
}

function targetLevels(candidate, entry, stop) {
  if (stop == null || stop >= entry) return { target1: null, target2: null };
  const threeR = entry + (entry - stop) * 3;
  if (candidate.high20 != null && candidate.high20 > entry) {
    const target1 = Math.min(candidate.high20, threeR);
    const target2 = candidate.high20 > target1 * 1.03 ? candidate.high20 : null;
    return { target1, target2 };
  }
  return { target1: threeR, target2: null };
}

export function validateTradePlanMath(plan, account = STRATEGY_V6.account) {
  const invalid = [];
  if (plan.referenceEntry == null || plan.stop == null || plan.referenceEntry <= plan.stop) invalid.push("STOP_INVALID");
  if (plan.referenceEntry == null || plan.target1 == null || plan.target1 <= plan.referenceEntry) invalid.push("TARGET_INVALID");
  if (plan.grossRR == null || !Number.isFinite(plan.grossRR) || plan.grossRR <= 0) invalid.push("RR_INVALID");
  if (plan.executable && (!Number.isFinite(plan.quantity) || plan.quantity < account.lotSize)) invalid.push("QUANTITY_INVALID");
  if (plan.executable && (plan.capitalRequired == null || plan.capitalRequired > account.equity)) invalid.push("ACCOUNT_CAPITAL_EXCEEDED");
  return [...new Set(invalid)];
}

function planAtEntry(candidate, entry, context) {
  const account = context.account || STRATEGY_V6.account;
  const stop = structuralStop(candidate, entry);
  const { target1, target2 } = targetLevels(candidate, entry, stop);
  const grossRR = stop == null || target1 == null || entry <= stop ? null : (target1 - entry) / (entry - stop);
  const invalidReason = validateTradePlanMath({ referenceEntry: entry, stop, target1, grossRR, executable: false }, account);

  let quantity = 0;
  let capitalRequired = null;
  let estimatedFees = null;
  let maxLoss = null;
  let netRR = null;
  if (!invalidReason.length) {
    const maxByCapital = Math.floor(account.equity / (entry * account.lotSize)) * account.lotSize;
    const riskBudget = account.equity * account.riskPerTradePct;
    for (let proposed = maxByCapital; proposed >= account.lotSize; proposed -= account.lotSize) {
      const stopCosts = tradingCosts(entry, stop, proposed, account);
      const proposedLoss = (entry - stop) * proposed + (stopCosts.total || 0);
      const entryCapital = entry * proposed + (stopCosts.buyFees || 0);
      if (entryCapital <= account.equity && proposedLoss <= riskBudget) {
        quantity = proposed;
        capitalRequired = entryCapital;
        maxLoss = proposedLoss;
        const targetCosts = tradingCosts(entry, target1, proposed, account);
        const netProfit = (target1 - entry) * proposed - (targetCosts.total || 0);
        netRR = proposedLoss > 0 ? netProfit / proposedLoss : null;
        estimatedFees = targetCosts.total;
        break;
      }
    }
  }
  const executable = quantity >= account.lotSize && capitalRequired != null && capitalRequired <= account.equity;
  return {
    entryType: "CURRENT",
    entryLow: round2(entry * 0.997),
    entryHigh: round2(entry * 1.003),
    referenceEntry: round2(entry),
    stop: round2(stop),
    target1: round2(target1),
    target2: round2(target2),
    grossRR: round2(grossRR),
    netRR: executable ? round2(netRR) : null,
    quantity,
    capitalRequired: round2(capitalRequired),
    estimatedFees: round2(estimatedFees),
    maxLoss: round2(maxLoss),
    executable,
    invalidReason,
  };
}

function limitRiskFlags(candidate) {
  const limitPct = /^(30|68)/.test(candidate.code || "") ? 20 : 10;
  const change = Number(candidate.change);
  if (!Number.isFinite(change)) return [];
  if (change >= limitPct - 0.3) return ["LIMIT_UP_RISK", "CHASE_RISK_EXTREME", "FILL_PROBABILITY_LOW"];
  if (change >= limitPct - 1) return ["LIMIT_UP_RISK", "FILL_PROBABILITY_LOW"];
  return [];
}

function tradeabilityFor(plan, candidate) {
  const entry = plan.referenceEntry;
  const position = entry != null && candidate.high != null && candidate.low != null && candidate.high > candidate.low
    ? (entry - candidate.low) / (candidate.high - candidate.low)
    : candidate.position;
  const entryDistance = entry != null && candidate.ma5 != null ? Math.abs(entry / candidate.ma5 - 1) * 100 : null;
  const stopDistance = entry != null && plan.stop != null ? (entry - plan.stop) / entry * 100 : null;
  const parts = [
    { key: "entryLocation", label: "Entry Location", score: entryDistance == null ? (position == null ? null : clampScore(100 - Math.abs(position - 0.5) * 140)) : clampScore(100 - entryDistance * 22), available: entryDistance != null || position != null },
    { key: "riskReward", label: "Risk Reward", score: rrScore(plan.netRR ?? plan.grossRR), available: plan.netRR != null || plan.grossRR != null },
    { key: "stopQuality", label: "Stop Quality", score: stopDistance == null ? null : clampScore(100 - (stopDistance - 3) ** 2 * 5), available: stopDistance != null },
    { key: "chaseRisk", label: "Chase Risk", score: position == null ? null : clampScore(100 - Math.max(0, position - 0.7) * 190 - Math.max(0, (candidate.change || 0) - 5) * 7), available: position != null },
    { key: "t1GapRisk", label: "T+1 Risk", score: candidate.change == null ? null : clampScore(85 - Math.max(0, Math.abs(candidate.change) - 4) * 10), available: candidate.change != null },
    { key: "accountExecution", label: "Account Execution", score: plan.executable ? 100 : 0, available: true },
  ];
  const result = weightedScore(parts, STRATEGY_V6.tradeabilityWeights);
  return { score: result.score, parts, missing: result.missing };
}

function failedGatesFor(plan, tradeability, candidate, context) {
  const gates = [...plan.invalidReason];
  if (!plan.executable) gates.push("ACCOUNT_NOT_EXECUTABLE");
  if ((plan.netRR ?? 0) < STRATEGY_V6.final.minNetRR) gates.push("RR_TOO_LOW");
  if (tradeability.score < STRATEGY_V6.final.minTradeability) gates.push("TRADEABILITY_TOO_LOW");
  const chase = tradeability.parts.find((part) => part.key === "chaseRisk")?.score;
  if (chase != null && chase < 55) gates.push("CHASE_RISK_HIGH");
  const entryLocation = tradeability.parts.find((part) => part.key === "entryLocation")?.score;
  if (entryLocation != null && entryLocation < 60) gates.push("ENTRY_TOO_FAR");
  if (!phaseAllowsBuy(context.marketPhase)) gates.push("TIME_PHASE_NOT_CONFIRMED");
  if ((candidate.missingFactors || []).length > 3) gates.push("DATA_INCOMPLETE");
  gates.push(...limitRiskFlags(candidate));
  return [...new Set(gates)];
}

function triggerCandidates(candidate) {
  const candidates = [];
  if (candidate.ma5 != null && candidate.ma5 > 0) {
    candidates.push({ entry: candidate.currentPrice > candidate.ma5 ? candidate.ma5 : candidate.ma5 * 1.002, description: candidate.currentPrice > candidate.ma5 ? `回踩MA5附近${candidate.ma5.toFixed(2)}并企稳` : `重新站上MA5 ${candidate.ma5.toFixed(2)}上方并确认` });
  }
  if (candidate.ma10 != null && candidate.ma10 > 0 && candidate.ma10 < candidate.currentPrice) {
    candidates.push({ entry: candidate.ma10, description: `回踩MA10附近${candidate.ma10.toFixed(2)}并企稳` });
  }
  candidates.push({ entry: candidate.currentPrice * 0.98, description: `回落至${(candidate.currentPrice * 0.98).toFixed(2)}附近并出现承接` });
  const unique = new Map();
  for (const item of candidates) if (item.entry > 0) unique.set(item.entry.toFixed(3), item);
  return [...unique.values()];
}

function waitingReasonFrom(gates) {
  const labels = {
    RR_TOO_LOW: "当前净盈亏比未达到1.8",
    TRADEABILITY_TOO_LOW: "当前位置交易性不足",
    CHASE_RISK_HIGH: "追高风险偏高",
    ENTRY_TOO_FAR: "买点距离均线过远",
    ACCOUNT_NOT_EXECUTABLE: "当前账户无法按风险预算买入100股",
    TIME_PHASE_NOT_CONFIRMED: "当前交易阶段不允许形成现在买入结论",
    STOP_INVALID: "止损结构无效",
    TARGET_INVALID: "目标价结构无效",
    DATA_INCOMPLETE: "关键数据完整度不足",
    LIMIT_UP_RISK: "接近涨停，成交概率不足",
  };
  return gates.map((gate) => labels[gate]).filter(Boolean).slice(0, 3).join("；") || "尚未满足最终交易门槛";
}

export function buildTradePlan(candidate, context) {
  const current = planAtEntry(candidate, candidate.currentPrice, context);
  const currentTradeability = tradeabilityFor(current, candidate);
  const failedGates = failedGatesFor(current, currentTradeability, candidate, context);
  const severeFlags = limitRiskFlags(candidate);
  const mathValid = current.invalidReason.length === 0;
  const currentBuyable = mathValid && failedGates.length === 0 && severeFlags.length === 0;

  let chosen = current;
  let status = "WATCH_ONLY";
  let projectedTradeability = null;
  let chosenFailedGates = failedGates;
  let upgradeTrigger = "暂无有效A级升级触发条件。";
  if (!mathValid) {
    status = "INVALID";
  } else if (context.marketPhase === "OPEN_AUCTION") {
    status = candidate.auctionIndicativePrice != null && current.executable && severeFlags.length === 0 ? "AUCTION_WATCH" : "WATCH_ONLY";
  } else if (context.marketPhase === "WAIT_OPEN") {
    status = current.executable && severeFlags.length === 0 ? "WAIT_OPEN" : "WATCH_ONLY";
  } else if (phaseAllowsBuy(context.marketPhase) && currentBuyable) {
    status = "BUYABLE";
    upgradeTrigger = null;
  } else {
    const projections = triggerCandidates(candidate).flatMap((trigger) => {
      const plan = planAtEntry(candidate, trigger.entry, context);
      const tradeability = tradeabilityFor(plan, candidate);
      const gates = failedGatesFor(plan, tradeability, candidate, { ...context, marketPhase: "CONTINUOUS_AM" }).filter((gate) => gate !== "TIME_PHASE_NOT_CONFIRMED");
      const valid = gates.length === 0;
      return valid ? [{ trigger, plan, tradeability, gates }] : [];
    }).sort((a, b) => b.tradeability.score - a.tradeability.score || (b.plan.netRR || 0) - (a.plan.netRR || 0));
    if (projections.length) {
      const projected = projections[0];
      chosen = projected.plan;
      chosen.entryType = "TRIGGER";
      status = "WAIT_TRIGGER";
      projectedTradeability = projected.tradeability;
      chosenFailedGates = projected.gates;
      upgradeTrigger = `${projected.trigger.description}；届时净盈亏比${projected.plan.netRR.toFixed(2)}、Projected Tradeability ${projected.tradeability.score.toFixed(1)}，需重新确认全部Gate。`;
    }
  }

  const effectiveTradeability = status === "WAIT_TRIGGER" && projectedTradeability ? projectedTradeability : currentTradeability;
  return {
    status,
    ...chosen,
    tradePlanValid: chosen.invalidReason.length === 0,
    failedGates: chosenFailedGates,
    currentFailedGates: failedGates,
    currentTradeability: round2(currentTradeability.score),
    projectedTradeability: projectedTradeability ? round2(projectedTradeability.score) : null,
    effectiveTradeability: round2(effectiveTradeability.score),
    tradeabilityParts: effectiveTradeability.parts,
    tradeabilityMissing: effectiveTradeability.missing,
    waitingReason: status === "BUYABLE" ? null : waitingReasonFrom(failedGates),
    upgradeTrigger,
    invalidation: chosen.stop == null ? "交易计划无效，已从最终候选剔除。" : `跌破${chosen.stop.toFixed(2)}，交易逻辑失效。`,
    severeFlags,
  };
}

export function dataConfidenceFor(strengthParts, tradePlan) {
  const all = [...strengthParts, ...(tradePlan.tradeabilityParts || [])];
  if (!all.length) return 0;
  return clampScore(all.filter((part) => part.available && part.score != null).length / all.length * 100);
}

function decisionScore(candidate) {
  return clampScore(candidate.strength * 0.45 + candidate.tradePlan.effectiveTradeability * 0.45 + candidate.dataConfidence * 0.10);
}

function statusPriority(status) {
  return status === "BUYABLE" ? 0 : status === "WAIT_TRIGGER" ? 1 : status === "AUCTION_WATCH" ? 2 : status === "WAIT_OPEN" ? 3 : 9;
}

function contributionReason(part, candidate) {
  const plan = candidate.tradePlan;
  const reasons = {
    market: `市场环境评分${part.score.toFixed(0)}`,
    sector: `${candidate.sector}板块评分${part.score.toFixed(0)}`,
    relativeStrength: `5日涨幅${candidate.ret5 == null ? "数据不足" : `${candidate.ret5.toFixed(1)}%`}，20日涨幅${candidate.ret20 == null ? "数据不足" : `${candidate.ret20.toFixed(1)}%`}`,
    trend: `现价与MA5/MA10/MA20的趋势结构评分${part.score.toFixed(0)}`,
    volumePrice: `量比${candidate.ratio == null ? "数据不足" : candidate.ratio.toFixed(2)}，量价评分${part.score.toFixed(0)}`,
    activity: `成交额${candidate.amount == null ? "数据不足" : `${(candidate.amount / 100000000).toFixed(1)}亿元`}，活跃度评分${part.score.toFixed(0)}`,
    priceQuality: `当前日内位置评分${part.score.toFixed(0)}`,
    entryLocation: `计划买入价${plan.referenceEntry?.toFixed(2)}，买点位置评分${part.score.toFixed(0)}`,
    riskReward: `毛盈亏比${plan.grossRR ?? "不可用"}，净盈亏比${plan.netRR ?? "不可用"}`,
    stopQuality: `止损${plan.stop?.toFixed(2) ?? "数据不足"}，止损质量评分${part.score.toFixed(0)}`,
    chaseRisk: `涨跌幅${candidate.change?.toFixed(1) ?? "数据不足"}%，追高控制评分${part.score.toFixed(0)}`,
    t1GapRisk: `T+1与跳空风险评分${part.score.toFixed(0)}`,
    accountExecution: plan.executable ? `账户可执行${plan.quantity}股，占用资金${plan.capitalRequired?.toFixed(0)}元` : "账户无法按计划买入100股",
  };
  return reasons[part.key] || `${part.label}评分${part.score.toFixed(0)}`;
}

function baseExplanation(candidate) {
  const contributions = [...candidate.factorScores.strength, ...candidate.tradePlan.tradeabilityParts]
    .filter((part) => part.available && part.score != null)
    .map((part) => ({ key: part.key, label: part.label, score: round2(part.score), reason: contributionReason(part, candidate) }));
  const strongestFactors = [...contributions].sort((a, b) => b.score - a.score).slice(0, 3);
  const weakFactors = [...contributions].sort((a, b) => a.score - b.score).slice(0, 2);
  return {
    whySelected: strongestFactors.map((part) => part.reason),
    strongestFactors,
    weakFactors,
    currentDecision: candidate.tradePlan.status === "BUYABLE" ? "当前满足执行门槛，可按计划区间控制性介入。" : candidate.tradePlan.status === "WAIT_TRIGGER" ? "暂不追价，等待升级触发后重新确认。" : candidate.tradePlan.status === "AUCTION_WATCH" ? "仅作集合竞价观察，禁止显示现在可买。" : "竞价已结束，等待连续竞价确认。",
    entryLogic: candidate.tradePlan.entryType === "TRIGGER" ? candidate.tradePlan.upgradeTrigger : `参考买入区间${candidate.tradePlan.entryLow?.toFixed(2)}～${candidate.tradePlan.entryHigh?.toFixed(2)}`,
    riskLogic: `止损${candidate.tradePlan.stop?.toFixed(2)}，最大计划亏损${candidate.tradePlan.maxLoss?.toFixed(2)}元，净盈亏比${candidate.tradePlan.netRR?.toFixed(2) ?? "不可用"}`,
    invalidationLogic: candidate.tradePlan.invalidation,
    accountLogic: candidate.tradePlan.executable ? `建议${candidate.tradePlan.quantity}股，预计占用${candidate.tradePlan.capitalRequired?.toFixed(2)}元。` : "账户无法执行100股，不能进入最终候选。",
    holdingExpectation: candidate.tradePlan.status === "BUYABLE" ? "预计持有1～3个交易日，触发止损或目标后按计划处理。" : "等待条件触发后再重新评估。",
  };
}

function rankingReason(candidate, index, final) {
  if (index === 0) {
    const next = final[1];
    if (!next) return `唯一通过全部硬门槛，Decision Score ${candidate.decisionScore.toFixed(1)}。`;
    const details = [];
    if (candidate.tradePlan.effectiveTradeability > next.tradePlan.effectiveTradeability) details.push("交易性更高");
    if ((candidate.tradePlan.netRR || 0) > (next.tradePlan.netRR || 0)) details.push("净盈亏比更好");
    if (candidate.strength > next.strength) details.push("Strength更高");
    return `Decision Score领先备选1；${details.slice(0, 2).join("、") || "综合强度、交易性和数据置信度更均衡"}，因此排第1。`;
  }
  const first = final[0];
  const gaps = [];
  if (candidate.tradePlan.effectiveTradeability < first.tradePlan.effectiveTradeability) gaps.push("交易性低于首选");
  if ((candidate.tradePlan.netRR || 0) < (first.tradePlan.netRR || 0)) gaps.push("净盈亏比低于首选");
  if (candidate.strength < first.strength) gaps.push("Strength低于首选");
  return `Decision Score ${candidate.decisionScore.toFixed(1)}，主要差距是${gaps.slice(0, 2).join("、") || "综合分略低"}。`;
}

export function selectFinalCandidates(radar, dataHealthStatus) {
  if (dataHealthStatus === "ERROR") return [];
  const pool = radar.flatMap((candidate) => {
    const plan = candidate.tradePlan;
    const allowedStatus = ["BUYABLE", "WAIT_TRIGGER", "AUCTION_WATCH", "WAIT_OPEN"].includes(plan.status);
    const severe = plan.severeFlags.some((flag) => ["LIMIT_UP_RISK", "CHASE_RISK_EXTREME", "FILL_PROBABILITY_LOW"].includes(flag));
    const phaseOnlyGate = ["AUCTION_WATCH", "WAIT_OPEN"].includes(plan.status) && plan.failedGates.every((gate) => gate === "TIME_PHASE_NOT_CONFIRMED");
    const allGatesPassed = plan.failedGates.length === 0 || phaseOnlyGate;
    const qualified = allowedStatus && allGatesPassed && candidate.strength >= STRATEGY_V6.final.minStrength && plan.effectiveTradeability >= STRATEGY_V6.final.minTradeability && (plan.netRR ?? 0) >= STRATEGY_V6.final.minNetRR && plan.executable && plan.tradePlanValid && candidate.dataConfidence >= STRATEGY_V6.final.minDataConfidence && !severe;
    return qualified ? [{ ...candidate, decisionScore: decisionScore(candidate) }] : [];
  });
  const sorted = pool.sort((a, b) => statusPriority(a.tradePlan.status) - statusPriority(b.tradePlan.status) || b.decisionScore - a.decisionScore || (b.tradePlan.netRR || 0) - (a.tradePlan.netRR || 0) || (b.tradePlan.tradeabilityParts.find((part) => part.key === "chaseRisk")?.score || 0) - (a.tradePlan.tradeabilityParts.find((part) => part.key === "chaseRisk")?.score || 0) || (b.amount || 0) - (a.amount || 0)).slice(0, STRATEGY_V6.final.maxCandidates);
  return sorted.map((candidate, index, final) => ({
    ...candidate,
    finalRank: index + 1,
    role: index === 0 ? "首选" : `备选${index}`,
    decisionExplanation: {
      ...baseExplanation(candidate),
      whyRankedHere: rankingReason(candidate, index, final),
      whyNotHigher: index === 0 ? null : rankingReason(candidate, index, final),
    },
  }));
}

export function gradeCandidate(candidate) {
  if (candidate.tradePlan?.status === "BUYABLE") return "A";
  if (["WAIT_TRIGGER", "AUCTION_WATCH", "WAIT_OPEN"].includes(candidate.tradePlan?.status)) return "B";
  return "C";
}

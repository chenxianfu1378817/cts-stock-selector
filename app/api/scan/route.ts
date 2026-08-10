import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { env } from "cloudflare:workers";
import { STRATEGY_V6 } from "../../lib/strategy-v6.config.mjs";
import { coverageStatus, fetchPaginatedUniverse, mergeUniverseResults, rebaseUniverseCoverage } from "../../lib/universe-coverage.mjs";
import {
  MARKET_PHASE_LABELS,
  buildTradePlan,
  clampScore,
  createPercentileRanker,
  dataConfidenceFor,
  eligibility,
  gradeCandidate,
  marketPhaseAt,
  selectFinalCandidates,
  sortRadar,
  weightedScore,
} from "../../lib/strategy-v6.mjs";

type Row = Record<string, unknown>;
type ScorePart = { key: string; label: string; score: number | null; available: boolean };

function numeric(raw: unknown) {
  const value = Number(String(raw ?? "").replace(/[,，%％元]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function numberField(row: Row, ...names: string[]) {
  for (const name of names) {
    const exact = Object.entries(row).find(([key]) => key === name || key.startsWith(`${name}[`) || key.startsWith(`${name}:`));
    const value = exact ? numeric(exact[1]) : null;
    if (value != null) return value;
  }
  return null;
}

function textField(row: Row, ...names: string[]) {
  for (const name of names) {
    const exact = Object.entries(row).find(([key]) => key === name || key.startsWith(`${name}[`) || key.startsWith(`${name}:`));
    if (!exact || exact[1] == null) continue;
    return Array.isArray(exact[1]) ? exact[1].join("、") : String(exact[1]);
  }
  return "";
}

function stockCode(row: Row) {
  return textField(row, "股票代码").replace(/\D/g, "").slice(0, 6);
}

function rangeChange(row: Row, targetDays: number) {
  const values = Object.entries(row).flatMap(([key, raw]) => {
    const match = key.match(/涨跌幅\[(\d{8})-(\d{8})\]/);
    if (!match) return [];
    const start = Date.UTC(Number(match[1].slice(0, 4)), Number(match[1].slice(4, 6)) - 1, Number(match[1].slice(6, 8)));
    const end = Date.UTC(Number(match[2].slice(0, 4)), Number(match[2].slice(4, 6)) - 1, Number(match[2].slice(6, 8)));
    const value = numeric(raw);
    return value == null ? [] : [{ value, distance: Math.abs((end - start) / 86400000 - targetDays) }];
  });
  return values.sort((a, b) => a.distance - b.distance)[0]?.value ?? null;
}

function providerConfig() {
  const bindings = env as unknown as Record<string, string | undefined>;
  const apiKey = bindings.IWENCAI_API_KEY?.trim();
  if (!apiKey) throw new Error("服务端尚未配置问财 API Key");
  return { apiKey, baseUrl: (bindings.IWENCAI_BASE_URL || "https://openapi.iwencai.com").replace(/\/$/, "") };
}

async function queryPage(skill: string, question: string, page: number, limit: number, isCache = true) {
  const { apiKey, baseUrl } = providerConfig();
  const response = await fetch(`${baseUrl}/v1/query2data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Claw-Call-Type": "normal",
      "X-Claw-Skill-Id": skill,
      "X-Claw-Skill-Version": "1.0.0",
      "X-Claw-Plugin-Id": "none",
      "X-Claw-Plugin-Version": "none",
      "X-Claw-Trace-Id": randomBytes(32).toString("hex"),
    },
    body: JSON.stringify({ query: question, page: String(page), limit: String(limit), is_cache: isCache ? "1" : "0", expand_index: "true" }),
  });
  if (!response.ok) throw new Error(`问财接口返回 ${response.status}`);
  const payload = await response.json() as { datas?: Row[]; code_count?: number; status_code?: number; status_msg?: string };
  if (payload.status_code != null && payload.status_code !== 0) throw new Error(payload.status_msg || `问财接口状态 ${payload.status_code}`);
  return { count: payload.code_count ?? payload.datas?.length ?? 0, rows: payload.datas ?? [] };
}

async function querySmall(skill: string, question: string, limit: number) {
  return queryPage(skill, question, 1, limit);
}

function marketScore(breadthRows: Row[], indexRows: Row[]) {
  const breadth = breadthRows[0] || {};
  const up = numberField(breadth, "上涨家数");
  const down = numberField(breadth, "下跌家数");
  const flat = numberField(breadth, "平盘家数") ?? 0;
  const suspended = numberField(breadth, "停牌家数") ?? 0;
  const upRatio = up != null && down != null && up + down > 0 ? up / (up + down) : null;
  const changes = indexRows.map((row) => numberField(row, "涨跌幅", "最新涨跌幅")).filter((value): value is number => value != null);
  const indexChange = changes.length ? changes.reduce((sum, value) => sum + value, 0) / changes.length : null;
  const score = upRatio == null && indexChange == null ? null : clampScore(((upRatio ?? 0.5) * 65 + (((indexChange ?? 0) + 2) / 4) * 35) * 100);
  const universeEstimate = up != null && down != null ? up + down + flat + suspended : null;
  return { score, state: score == null ? "未知" : score >= 65 ? "进攻" : score < 38 ? "退潮" : "中性", upRatio, indexChange, up, down, flat, suspended, universeEstimate };
}

function sectorFor(row: Row, sectors: Row[]) {
  const industry = textField(row, "所属同花顺行业", "所属行业");
  const matches = sectors.map((sector, index) => ({
    name: textField(sector, "指数简称", "板块名称"),
    index,
    change: numberField(sector, "涨跌幅"),
  })).filter((sector) => sector.name && industry.includes(sector.name));
  if (!matches.length) return { name: industry || "板块待确认", score: null };
  const match = matches[0];
  return { name: match.name, score: clampScore(100 - match.index / Math.max(1, sectors.length - 1) * 65 + ((match.change ?? 0) + 3) / 6 * 35) };
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { mode?: "entry" | "close" };
    const now = new Date();
    const marketPhase = marketPhaseAt(now);
    const mode = body.mode === "close" ? "EOD" : "INTRADAY";
    const queryDate = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" }).format(now);
    const auctionFields = ["OPEN_AUCTION", "WAIT_OPEN"].includes(marketPhase) ? "、集合竞价最新价" : "";
    const exchanges = ["上海证券交易所A股", "深圳证券交易所A股"];
    const paginationOptions = { pageSize: STRATEGY_V6.coverage.pageSize, maxPages: STRATEGY_V6.coverage.maxPages, symbolFrom: stockCode, sequentialPages: true };
    const detailedParts = [];
    for (const exchange of exchanges) {
      detailedParts.push(await fetchPaginatedUniverse(
        (page, limit) => queryPage("hithink-market-query", `${queryDate}${exchange}，显示股票代码、股票简称、最新价${auctionFields}、昨日收盘价、开盘价、收盘价、涨跌幅、最高价、最低价、成交额、换手率、振幅、量比、主力资金净流入、所属同花顺行业、5日涨跌幅、20日涨跌幅、5日均线、10日均线、20日均线、近20日最高价、交易状态，按成交额从高到低排序`, page, limit),
        paginationOptions,
      ));
    }
    const auxiliaryResults = await Promise.allSettled([
      querySmall("hithink-sector-selector", `${queryDate}A股行业板块按涨跌幅排名，显示涨跌幅、主力净买入额`, 150),
      querySmall("hithink-market-query", `${queryDate}沪深A股上涨家数、下跌家数、平盘家数、停牌家数、两市成交额`, 5),
      querySmall("hithink-zhishu-query", `${queryDate}上证指数、深证成指、创业板指、沪深300涨跌幅`, 10),
    ]);
    const emptyQuery = { count: 0, rows: [] as Row[] };
    const [sectors, breadth, indices] = auxiliaryResults.map((result) => result.status === "fulfilled" ? result.value : emptyQuery);
    const auxiliaryFailures = auxiliaryResults.flatMap((result, index) => result.status === "rejected" ? [["行业板块", "市场宽度", "指数行情"][index]] : []);

    const detailedResult = mergeUniverseResults(detailedParts, stockCode);
    const market = marketScore(breadth.rows, indices.rows);
    const universeResult = rebaseUniverseCoverage(detailedResult, Math.max(detailedResult.coverage.expectedUniverse, market.universeEstimate || 0));
    const coverage = universeResult.coverage;
    const healthStatus = coverageStatus(coverage);
    const warnings = [
      "timestamp unavailable",
      "交易日历仅按工作日判断，法定节假日状态未接入交易所日历，不能视为100%准确。",
    ];
    if (auxiliaryFailures.length) warnings.push(`辅助数据源降级：${auxiliaryFailures.join("、")}暂不可用。`);
    if (coverage.providerLimitDetected) warnings.push("Provider first page limit detected; remaining pages fetched.");
    if (coverage.truncated) warnings.push("Provider result truncated");
    if (healthStatus === "ERROR") warnings.push("全市场覆盖率低于90%，最终候选已禁用。");
    if (healthStatus === "DEGRADED") warnings.push("全市场覆盖率低于95%，结果降级。");
    const optionalMissing: Record<string, number> = {};
    const funnel = {
      universe: coverage.expectedUniverse,
      fetched: coverage.fetchedSymbols,
      unique: coverage.uniqueSymbols,
      validData: 0,
      eligible: 0,
      scored: 0,
      radar: 0,
      executablePool: 0,
      final: 0,
      gradeA: 0,
      gradeB: 0,
      gradeC: 0,
      excluded: { notCommonAshare: 0, riskWarning: 0, suspended: 0, invalidQuote: 0, other: 0 },
    };

    const valid = universeResult.rows.flatMap((row) => {
      const code = stockCode(row);
      const name = textField(row, "股票简称");
      const latest = numberField(row, "最新价", "收盘价");
      const previousClose = numberField(row, "昨日收盘价");
      const openPrice = numberField(row, "开盘价");
      const explicitAuction = numberField(row, "集合竞价最新价");
      const auctionIndicativePrice = ["OPEN_AUCTION", "WAIT_OPEN"].includes(marketPhase) ? explicitAuction : null;
      const currentPrice = auctionIndicativePrice ?? latest ?? previousClose;
      const high = numberField(row, "最高价");
      const low = numberField(row, "最低价");
      if (!code || !name || currentPrice == null || currentPrice <= 0 || high == null || low == null || high < low) {
        funnel.excluded.invalidQuote++;
        return [];
      }
      funnel.validData++;
      const status = eligibility({ code, name, price: currentPrice, suspended: /停牌/.test(textField(row, "交易状态", "停复牌")) });
      if (status !== "eligible") {
        funnel.excluded[status as keyof typeof funnel.excluded]++;
        return [];
      }
      funnel.eligible++;
      return [{
        row,
        code,
        name,
        currentPrice,
        lastTradePrice: ["CONTINUOUS_AM", "CONTINUOUS_PM", "LUNCH_BREAK", "CLOSE_AUCTION", "POST_CLOSE"].includes(marketPhase) ? latest : null,
        auctionIndicativePrice,
        auctionDataReliable: auctionIndicativePrice != null,
        previousClose,
        openPrice,
        high,
        low,
        change: numberField(row, "最新涨跌幅", "涨跌幅") ?? rangeChange(row, 1) ?? 0,
        amount: numberField(row, "成交额"),
        turnover: numberField(row, "换手率"),
        flow: numberField(row, "主力资金流向", "主力资金净流入"),
        ratio: numberField(row, "量比"),
        ret5: numberField(row, "5日涨跌幅") ?? rangeChange(row, 5),
        ret20: numberField(row, "20日涨跌幅") ?? rangeChange(row, 20),
        ma5: numberField(row, "5日均线", "ma5"),
        ma10: numberField(row, "10日均线", "ma10"),
        ma20: numberField(row, "20日均线", "ma20"),
        high20: numberField(row, "近20日最高价", "最高价最大值"),
      }];
    });

    const amounts = valid.map((item) => item.amount).filter((value): value is number => value != null);
    const changes = valid.map((item) => item.change);
    const ret5s = valid.map((item) => item.ret5).filter((value): value is number => value != null);
    const ret20s = valid.map((item) => item.ret20).filter((value): value is number => value != null);
    const amountRank = createPercentileRanker(amounts);
    const changeRank = createPercentileRanker(changes);
    const ret5Rank = createPercentileRanker(ret5s);
    const ret20Rank = createPercentileRanker(ret20s);
    const scored = valid.map((item) => {
      const position = item.high === item.low ? null : (item.currentPrice - item.low) / (item.high - item.low);
      const sector = sectorFor(item.row, sectors.rows);
      const strengthParts: ScorePart[] = [
        { key: "market", label: "Market", score: market.score, available: market.score != null },
        { key: "sector", label: "Sector", score: sector.score, available: sector.score != null },
        { key: "relativeStrength", label: "Relative Strength", score: [changeRank(item.change), ret5Rank(item.ret5), ret20Rank(item.ret20)].reduce((sum, value, index) => sum + (value ?? 0) * [0.4, 0.35, 0.25][index], 0), available: item.ret5 != null || item.ret20 != null },
        { key: "trend", label: "Trend", score: item.ma20 == null ? null : clampScore((item.currentPrice >= item.ma20 ? 55 : 25) + (item.ma5 != null && item.currentPrice >= item.ma5 ? 20 : 0) + (item.ma10 != null && item.currentPrice >= item.ma10 ? 15 : 0) + (item.ma5 != null && item.ma10 != null && item.ma20 != null && item.ma5 >= item.ma10 && item.ma10 >= item.ma20 ? 10 : 0)), available: item.ma20 != null },
        { key: "volumePrice", label: "Volume Price", score: item.ratio == null ? null : clampScore(45 + Math.min(35, item.ratio * 18) + (item.change > 0 ? 20 : -10)), available: item.ratio != null },
        { key: "activity", label: "Activity", score: amountRank(item.amount), available: item.amount != null },
        { key: "priceQuality", label: "Price Quality", score: position == null ? null : clampScore(100 - Math.abs(position - 0.62) * 120), available: position != null },
      ];
      const strengthResult = weightedScore(strengthParts, STRATEGY_V6.strengthWeights);
      const base = { ...item, sector: sector.name, position, strength: strengthResult.score, missingFactors: strengthResult.missing };
      const tradePlan = buildTradePlan(base, { marketPhase, account: STRATEGY_V6.account });
      const dataConfidence = dataConfidenceFor(strengthParts, tradePlan);
      for (const key of [...strengthResult.missing, ...tradePlan.tradeabilityMissing]) optionalMissing[key] = (optionalMissing[key] || 0) + 1;
      const candidate = {
        code: item.code,
        name: item.name,
        currentPrice: item.currentPrice,
        lastTradePrice: item.lastTradePrice,
        auctionIndicativePrice: item.auctionIndicativePrice,
        previousClose: item.previousClose,
        openPrice: item.openPrice,
        high: item.high,
        low: item.low,
        change: item.change,
        amount: item.amount,
        turnover: item.turnover,
        flow: item.flow,
        ratio: item.ratio,
        ret5: item.ret5,
        ret20: item.ret20,
        ma5: item.ma5,
        ma10: item.ma10,
        ma20: item.ma20,
        high20: item.high20,
        sector: sector.name,
        position,
        strength: strengthResult.score,
        tradeability: tradePlan.currentTradeability,
        dataConfidence,
        tradePlan,
        factorScores: { strength: strengthParts, tradeability: tradePlan.tradeabilityParts },
        missingFactors: [...strengthResult.missing, ...tradePlan.tradeabilityMissing],
        flags: [...new Set([...tradePlan.failedGates, ...tradePlan.severeFlags])],
      };
      return { ...candidate, grade: gradeCandidate(candidate) };
    });

    funnel.scored = scored.length;
    const radar = sortRadar(scored).slice(0, STRATEGY_V6.radar.topN).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    const finalCandidates = selectFinalCandidates(radar, healthStatus);
    funnel.radar = radar.length;
    funnel.executablePool = radar.filter((candidate) => ["BUYABLE", "WAIT_TRIGGER", "AUCTION_WATCH", "WAIT_OPEN"].includes(candidate.tradePlan.status) && candidate.tradePlan.executable && candidate.tradePlan.tradePlanValid).length;
    funnel.final = finalCandidates.length;
    funnel.gradeA = radar.filter((candidate) => candidate.grade === "A").length;
    funnel.gradeB = radar.filter((candidate) => candidate.grade === "B").length;
    funnel.gradeC = radar.filter((candidate) => candidate.grade === "C").length;
    const coreFieldCompleteness = coverage.uniqueSymbols > 0 ? funnel.validData / coverage.uniqueSymbols : 0;
    const dataHealth = {
      status: healthStatus === "OK" && auxiliaryFailures.length ? "DEGRADED" : healthStatus,
      interfaceStatus: auxiliaryFailures.length ? "PARTIAL" : "OK",
      source: "同花顺问财",
      universeCount: coverage.expectedUniverse,
      fetchedCount: coverage.fetchedSymbols,
      uniqueCount: coverage.uniqueSymbols,
      coverageRatio: coverage.coverageRatio,
      truncated: coverage.truncated,
      pageCount: coverage.pageCount,
      providerLimitDetected: coverage.providerLimitDetected,
      coreFieldCompleteness,
      missingCriticalFields: coverage.uniqueSymbols - funnel.validData,
      missingOptionalFields: optionalMissing,
      quoteTimeStatus: "timestamp unavailable",
      scanTime: now.toISOString(),
      warnings,
    };

    return NextResponse.json({
      mode,
      strategyVersion: STRATEGY_V6.version,
      scanTime: now.toISOString(),
      marketPhase,
      marketPhaseLabel: MARKET_PHASE_LABELS[marketPhase],
      tradingCalendarVerified: false,
      universeCoverage: coverage,
      dataHealth,
      market,
      funnel,
      finalCandidates,
      internalRadar: radar,
      warning: marketPhase === "OPEN_AUCTION" ? "集合竞价阶段只提供AUCTION_WATCH，禁止产生现在买信号。" : marketPhase === "WAIT_OPEN" ? "竞价已结束，等待连续竞价确认。" : undefined,
    });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "选股服务暂时不可用", dataStatus: "ERROR" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: "请使用 POST 请求执行扫描" }, { status: 405 });
}

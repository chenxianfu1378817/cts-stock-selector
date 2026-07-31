import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { env } from "cloudflare:workers";

type Row = Record<string, unknown>;

const ACCOUNT_SIZE = 10_000;
const RISK_BUDGET = 100;
const MAX_POSITION = 6_000;

function numberFrom(row: Row, ...needles: string[]): number | null {
  for (const needle of needles) {
    for (const [key, raw] of Object.entries(row)) {
      if (!key.includes(needle)) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function textFrom(row: Row, ...needles: string[]): string {
  for (const needle of needles) {
    for (const [key, raw] of Object.entries(row)) {
      if (key.includes(needle) && raw != null) return Array.isArray(raw) ? raw.join("、") : String(raw);
    }
  }
  return "";
}

async function query(skill: string, question: string, limit = 100): Promise<{ count: number; rows: Row[] }> {
  const bindings = env as unknown as Record<string, string | undefined>;
  const apiKey = bindings.IWENCAI_API_KEY?.trim();
  if (!apiKey) throw new Error("服务端尚未配置问财 API Key");
  const baseUrl = (bindings.IWENCAI_BASE_URL || "https://openapi.iwencai.com").replace(/\/$/, "");
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
    body: JSON.stringify({
      query: question,
      page: "1",
      limit: String(limit),
      is_cache: "1",
      expand_index: "true",
    }),
  });
  if (!response.ok) throw new Error(`问财接口返回 ${response.status}`);
  const payload = (await response.json()) as { datas?: Row[]; code_count?: number };
  return { count: payload.code_count ?? payload.datas?.length ?? 0, rows: payload.datas ?? [] };
}

function percentile(value: number | null, values: number[]): number {
  if (value == null || values.length === 0) return 0;
  return values.filter((item) => item <= value).length / values.length;
}

function sectorMatch(row: Row, sectors: Row[]) {
  const industry = textFrom(row, "所属同花顺行业");
  const matches = sectors
    .map((item, index) => {
      const name = textFrom(item, "指数简称", "板块名称");
      const change = numberFrom(item, "涨跌幅[") ?? 0;
      const flow = numberFrom(item, "主力净买入额", "主力资金净流入") ?? 0;
      return { name, index, change, flow };
    })
    .filter((item) => item.name && industry.includes(item.name));
  if (!matches.length) return { name: "", score: 0 };
  const best = matches.sort((a, b) => a.index - b.index)[0];
  const rank = Math.max(0, 1 - best.index / 20);
  const change = Math.max(0, Math.min(1, (best.change + 1) / 6));
  return { name: best.name, score: 0.65 * rank + 0.35 * change };
}

function marketState(breadthRows: Row[], indexRows: Row[]) {
  const breadth = breadthRows[0] || {};
  const up = numberFrom(breadth, "上涨家数");
  const down = numberFrom(breadth, "下跌家数");
  const upRatio = up != null && down != null && up + down > 0 ? up / (up + down) : null;
  const changes = indexRows
    .map((row) => numberFrom(row, "涨跌幅[", "最新涨跌幅"))
    .filter((value): value is number => value != null);
  const indexChange = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
  const state = (upRatio != null && upRatio < 0.35) || (indexChange != null && indexChange <= -1)
    ? "退潮"
    : upRatio != null && upRatio >= 0.6 && indexChange != null && indexChange > 0
      ? "进攻"
      : "中性";
  return {
    state,
    upRatio,
    indexChange,
    note: state === "退潮"
      ? "市场宽度偏弱，系统禁止新开仓；结果仅供观察。"
      : state === "进攻"
        ? "市场环境允许参与，但仍只选择一只并严格执行止损。"
        : "市场处于中性，只接受位置和盈亏比都合格的机会。",
  };
}

function tradePlan(price: number, low: number, high20: number | null) {
  const stop = Math.max(low * 0.995, price * 0.97);
  const effectiveRisk = price - stop + price * 0.007;
  const quantity = Math.floor(Math.min(MAX_POSITION / price, RISK_BUDGET / effectiveRisk) / 100) * 100;
  if (quantity < 100 || price * quantity < 2_500) return null;
  const amount = price * quantity;
  const cost = Math.max(5, amount * 0.00015) * 2 + amount * (0.0005 + 0.00002);
  const target = price + 2 * effectiveRisk + cost / quantity;
  if (high20 != null && high20 > price && target > high20) return null;
  return { stop, quantity, amount, cost, target };
}

async function riskDetails(names: string[]) {
  if (!names.length) return new Map<string, Row>();
  const joined = names.join("、");
  const [finance, events] = await Promise.all([
    query("hithink-finance-query", `${joined}最新一期营业收入同比增长率、归母净利润同比增长率、经营现金流、资产负债率、ROE`, names.length + 2),
    query("hithink-event-query", `${joined}最新业绩预告、未来30日限售解禁、股东减持计划、监管函和立案调查`, names.length + 4),
  ]);
  const map = new Map<string, Row>();
  for (const row of [...finance.rows, ...events.rows]) {
    const name = textFrom(row, "股票简称");
    map.set(name, { ...(map.get(name) || {}), ...row });
  }
  return map;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { mode?: string };
    const mode = body.mode === "close" ? "close" : "entry";
    const now = new Date();
    const date = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const entryQuery = `${date}沪深A股，非ST，非退市整理，非北交所，上市超过250天，股价5元至60元，最新涨幅-1%至3%，成交额大于5亿元，换手率0.5%至10%，显示最新价、最高价、最低价、成交额、换手率、振幅、主力资金净流入、20日均线、60日均线、近5日涨跌幅、近20日涨跌幅、近20日最高价、动态市盈率、所属同花顺行业，按主力资金净流入从高到低排序`;
    const closeQuery = `${date}沪深A股，非ST，非退市整理，非北交所，上市超过250天，股价5元至60元，涨幅-3%至7%，成交额大于3亿元，显示最新价、最高价、最低价、成交额、换手率、振幅、主力资金净流入、20日均线、60日均线、近5日涨跌幅、近20日涨跌幅、近20日最高价、动态市盈率、所属同花顺行业，按成交额从高到低排序`;
    const [sectors, stocks, breadth, indices] = await Promise.all([
      query("hithink-sector-selector", `${date}A股行业板块按主力净买入额从高到低排名前20，显示当日涨跌幅、近3日涨跌幅、成交额、主力净买入额`, 20),
      query("hithink-astock-selector", mode === "entry" ? entryQuery : closeQuery, 300),
      query("hithink-market-query", `${date}沪深A股上涨家数、下跌家数、涨停家数、跌停家数、两市成交额`, 5),
      query("hithink-zhishu-query", `${date}上证指数、深证成指、创业板指、沪深300最新点位、涨跌幅`, 10),
    ]);

    const market = marketState(breadth.rows, indices.rows);
    const amounts = stocks.rows.map((row) => numberFrom(row, "成交额[")).filter((v): v is number => v != null);
    const flows = stocks.rows.map((row) => numberFrom(row, "主力资金流向", "主力资金净流入")).filter((v): v is number => v != null);
    const prelim = stocks.rows.flatMap((row) => {
      const name = textFrom(row, "股票简称");
      const code = textFrom(row, "股票代码");
      const price = numberFrom(row, "最新价", "收盘价[");
      const change = numberFrom(row, "最新涨跌幅", "涨跌幅[");
      const high = numberFrom(row, "最高价[");
      const low = numberFrom(row, "最低价[");
      const amount = numberFrom(row, "成交额[");
      const turnover = numberFrom(row, "换手率[");
      const amplitude = numberFrom(row, "振幅[");
      const flow = numberFrom(row, "主力资金流向", "主力资金净流入");
      const ma20 = numberFrom(row, "ma20[", "20日均线");
      const ma60 = numberFrom(row, "ma60[", "60日均线");
      const high20 = numberFrom(row, "最高价最大值", "近20日最高价");
      if (!name || !code || price == null || change == null || high == null || low == null || amount == null || turnover == null || high <= low) return [];
      if (amplitude != null && amplitude > (mode === "entry" ? 7 : 12)) return [];
      const sector = sectorMatch(row, sectors.rows);
      if (!sector.name || sector.score < (mode === "entry" ? 0.5 : 0.35)) return [];
      const dayPosition = (price - low) / (high - low);
      if (mode === "entry" && (dayPosition < 0.2 || dayPosition > 0.78 || (flow != null && flow <= 0))) return [];
      const plan = tradePlan(price, low, high20);
      if (!plan) return [];
      const liquidity = percentile(amount, amounts);
      const moneyFlow = percentile(flow, flows);
      const trend = ma20 != null && ma60 != null && price > ma20 && ma20 > ma60 ? 1 : ma20 != null && price > ma20 ? 0.5 : 0.2;
      const entryQuality = Math.max(0, 1 - Math.abs(dayPosition - 0.5) / 0.5);
      const score = 100 * (0.35 * sector.score + 0.2 * moneyFlow + 0.15 * liquidity + 0.2 * entryQuality + 0.1 * trend);
      return [{ row, name, code, price, change, amount, turnover, flow, sector: sector.name, score, plan, dayPosition }];
    }).sort((a, b) => b.score - a.score).slice(0, 8);

    const details = await riskDetails(prelim.slice(0, 5).map((item) => item.name));
    const candidates = prelim.flatMap((item) => {
      const detail = details.get(item.name) || {};
      const profitGrowth = numberFrom(detail, "归母净利润同比增长率", "净利润增长率下限");
      const revenueGrowth = numberFrom(detail, "营业收入同比增长率");
      const debt = numberFrom(detail, "资产负债率");
      const investigation = JSON.stringify(detail).includes("立案调查");
      const reduction = JSON.stringify(detail).includes("减持计划");
      if (investigation || reduction || (profitGrowth != null && profitGrowth < -50)) return [];
      const reasons = [
        `所属${item.sector}进入当日资金强势区`,
        `当前涨幅${item.change.toFixed(2)}%，没有远离可执行价格`,
        item.flow != null ? `主力资金净流入约${(item.flow / 100_000_000).toFixed(2)}亿元` : `成交额约${(item.amount / 100_000_000).toFixed(1)}亿元`,
      ];
      if (revenueGrowth != null) reasons.push(`最新营业收入同比${revenueGrowth >= 0 ? "增长" : "下降"}${Math.abs(revenueGrowth).toFixed(1)}%`);
      if (profitGrowth != null) reasons.push(`最新归母净利润同比${profitGrowth >= 0 ? "增长" : "下降"}${Math.abs(profitGrowth).toFixed(1)}%`);
      const risks = [
        "A股T+1导致买入当日无法止损",
        debt != null ? `资产负债率约${debt.toFixed(1)}%` : "需持续关注最新公告与事件风险",
        item.change > 5 ? "当日涨幅较高，次日存在回吐风险" : "板块转弱时个股可能同步回落",
      ];
      const status = market.state === "退潮" ? "观察" : item.score >= 65 ? "可执行" : item.score >= 55 ? "等待确认" : "观察";
      return [{
        code: item.code,
        name: item.name,
        price: item.price,
        change: item.change,
        sector: item.sector,
        score: item.score,
        status,
        reasons,
        risks,
        entry: item.price * 1.003,
        stop: item.plan.stop,
        target: item.plan.target,
        quantity: item.plan.quantity,
        amount: item.plan.amount,
        cost: item.plan.cost,
        holding: "达到1R后将止损提高到成本附近；未触及止损且板块未转弱时继续持有。",
        exit: "第一目标卖出一半，剩余仓位以前一交易日低点移动止盈；最长持有5个交易日。",
        cancel: "超过买入上限、板块跌出强势区、主力资金转负或出现放量长阴时取消。",
      }];
    }).slice(0, 5);

    return NextResponse.json({
      asOf: new Date().toISOString(),
      source: "同花顺问财",
      mode,
      market,
      universeCount: stocks.count,
      candidates,
      warning: mode === "entry"
        ? "“可执行”仍需核对页面显示的数据时间和价格上限；超过上限不要追。"
        : "收盘候选只能用于下一交易日，不能按收盘前价格直接下单。",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "选股服务暂时不可用";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { candidatesFromRecord, dedupeRecords, readV6History, recordFromScan, removeRecord, V6_HISTORY_KEY } from "./lib/history-v6.mjs";

type Factor = { key: string; label: string; score: number | null; available: boolean };
type TradePlan = {
  status: "BUYABLE" | "WAIT_TRIGGER" | "AUCTION_WATCH" | "WAIT_OPEN" | "WATCH_ONLY" | "INVALID";
  entryType: "CURRENT" | "RANGE" | "TRIGGER";
  entryLow: number | null;
  entryHigh: number | null;
  referenceEntry: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  grossRR: number | null;
  netRR: number | null;
  quantity: number;
  capitalRequired: number | null;
  estimatedFees: number | null;
  maxLoss: number | null;
  executable: boolean;
  tradePlanValid: boolean;
  failedGates: string[];
  currentTradeability: number;
  projectedTradeability: number | null;
  effectiveTradeability: number;
  tradeabilityParts: Factor[];
  waitingReason: string | null;
  upgradeTrigger: string | null;
  invalidation: string;
  severeFlags: string[];
};
type Explanation = {
  whySelected: string[];
  strongestFactors: Array<{ key: string; label: string; score: number; reason: string }>;
  weakFactors: Array<{ key: string; label: string; score: number; reason: string }>;
  whyRankedHere: string;
  whyNotHigher?: string | null;
  currentDecision: string;
  entryLogic: string;
  riskLogic: string;
  invalidationLogic: string;
  accountLogic: string;
  holdingExpectation: string;
};
type Candidate = {
  rank: number;
  finalRank?: number;
  role?: string;
  code: string;
  name: string;
  currentPrice: number;
  change: number;
  sector: string;
  amount: number | null;
  strength: number;
  tradeability: number;
  dataConfidence: number;
  decisionScore?: number;
  grade: "A" | "B" | "C";
  tradePlan: TradePlan;
  factorScores: { strength: Factor[]; tradeability: Factor[] };
  flags: string[];
  decisionExplanation?: Explanation;
};
type Scan = {
  mode: "INTRADAY" | "EOD";
  strategyVersion: string;
  scanTime: string;
  marketPhase: string;
  marketPhaseLabel: string;
  tradingCalendarVerified: boolean;
  universeCoverage: { expectedUniverse: number; fetchedSymbols: number; uniqueSymbols: number; coverageRatio: number; pageCount: number; truncated: boolean; providerLimitDetected: boolean };
  dataHealth: { status: "OK" | "DEGRADED" | "ERROR"; interfaceStatus: string; quoteTimeStatus: string; scanTime: string; coreFieldCompleteness: number; warnings: string[] };
  market: { state: string; upRatio: number | null; indexChange: number | null };
  funnel: { universe: number; fetched: number; unique: number; validData: number; eligible: number; scored: number; radar: number; executablePool: number; final: number; gradeA: number; gradeB: number; gradeC: number; excluded: Record<string, number> };
  finalCandidates: Candidate[];
  internalRadar: Candidate[];
  warning?: string;
};
type HistoryRecord = Record<string, unknown> & { id: string; strategyVersion: string; scanTime: string; mode: "INTRADAY" | "EOD" };
type HistoryQuote = { recordId: string; code: string; currentPrice: number | null; change: number | null; days: number };

const number = (value: number | null | undefined, digits = 2) => value == null ? "数据不足" : value.toFixed(digits);
const percent = (value: number | null | undefined) => value == null ? "数据不足" : `${(value * 100).toFixed(1)}%`;
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "timestamp unavailable";
const statusText: Record<string, string> = { BUYABLE: "可执行", WAIT_TRIGGER: "等待触发", AUCTION_WATCH: "竞价观察", WAIT_OPEN: "等待开盘确认", WATCH_ONLY: "仅观察", INVALID: "计划无效" };

function readInitialHistory(): HistoryRecord[] {
  if (typeof window === "undefined") return [];
  try { return readV6History(localStorage) as HistoryRecord[]; } catch { return []; }
}

function FinalCandidateCard({ candidate }: { candidate: Candidate }) {
  const plan = candidate.tradePlan;
  const explanation = candidate.decisionExplanation;
  return <article className="final-card">
    <div className="final-card-head">
      <div><span className="role-badge">{candidate.role}</span><h3>{candidate.name}</h3><p>{candidate.code} · {candidate.sector}</p></div>
      <span className={`decision-status status-${plan.status.toLowerCase()}`}>{statusText[plan.status] || plan.status}</span>
    </div>
    <div className="final-score-strip">
      <div><span>当前价</span><strong>{number(candidate.currentPrice)}</strong><small className={candidate.change >= 0 ? "positive" : "negative"}>{candidate.change >= 0 ? "+" : ""}{number(candidate.change)}%</small></div>
      <div><span>Decision Score</span><strong>{number(candidate.decisionScore, 1)}</strong></div>
      <div><span>Strength</span><strong>{number(candidate.strength, 1)}</strong></div>
      <div><span>{plan.projectedTradeability == null ? "Tradeability" : "Projected Tradeability"}</span><strong>{number(plan.projectedTradeability ?? plan.currentTradeability, 1)}</strong></div>
    </div>
    <section className="explanation-block">
      <h4>为什么选它</h4>
      <ol>{explanation?.whySelected.map((reason) => <li key={reason}>{reason}</li>)}</ol>
      <div className="factor-contributions">
        <div><b>最强3项</b>{explanation?.strongestFactors.map((factor) => <p key={factor.key}><span>{factor.label} {number(factor.score, 0)}</span>{factor.reason}</p>)}</div>
        <div><b>主要拖累2项</b>{explanation?.weakFactors.map((factor) => <p key={factor.key}><span>{factor.label} {number(factor.score, 0)}</span>{factor.reason}</p>)}</div>
      </div>
      <p className="ranking-reason"><b>为什么排在这里：</b>{explanation?.whyRankedHere}</p>
    </section>
    <section className="plan-block">
      <h4>统一交易计划</h4>
      <div className="plan-grid">
        <div><span>计划买入条件</span><strong>{plan.entryType === "TRIGGER" ? "触发后确认" : "当前区间"}</strong></div>
        <div><span>参考买入区间</span><strong>{number(plan.entryLow)}～{number(plan.entryHigh)}</strong></div>
        <div><span>止损</span><strong className="negative">{number(plan.stop)}</strong></div>
        <div><span>目标1</span><strong className="positive">{number(plan.target1)}</strong></div>
        <div><span>目标2</span><strong>{number(plan.target2)}</strong></div>
        <div><span>毛盈亏比</span><strong>{number(plan.grossRR)}:1</strong></div>
        <div><span>净盈亏比（含费用/滑点）</span><strong>{plan.netRR == null ? "Net RR unavailable" : `${number(plan.netRR)}:1`}</strong></div>
        <div><span>建议股数</span><strong>{plan.executable ? `${plan.quantity}股` : "不可执行"}</strong></div>
        <div><span>资金占用</span><strong>{plan.capitalRequired == null ? "数据不足" : `${number(plan.capitalRequired)}元`}</strong></div>
        <div><span>预计费用</span><strong>{plan.estimatedFees == null ? "数据不足" : `${number(plan.estimatedFees)}元`}</strong></div>
        <div><span>最大计划亏损</span><strong className="negative">{plan.maxLoss == null ? "数据不足" : `${number(plan.maxLoss)}元`}</strong></div>
        <div><span>预计持有</span><strong>{explanation?.holdingExpectation}</strong></div>
      </div>
      <div className="decision-copy">
        <p><b>当前应该怎么做：</b>{explanation?.currentDecision}</p>
        <p><b>买入逻辑：</b>{explanation?.entryLogic}</p>
        <p><b>风险逻辑：</b>{explanation?.riskLogic}</p>
        <p><b>账户逻辑：</b>{explanation?.accountLogic}</p>
        {plan.waitingReason ? <p><b>为什么等待：</b>{plan.waitingReason}</p> : null}
        {plan.upgradeTrigger ? <p><b>什么时候升级：</b>{plan.upgradeTrigger}</p> : null}
        <p><b>什么时候失效：</b>{explanation?.invalidationLogic}</p>
      </div>
    </section>
  </article>;
}

function RadarPool({ candidates }: { candidates: Candidate[] }) {
  return <div className="radar-table-wrap"><table className="radar-table"><thead><tr><th>排名</th><th>股票</th><th>Strength</th><th>Tradeability</th><th>计划状态</th><th>账户</th><th>未进入Final原因</th></tr></thead><tbody>{candidates.map((candidate) => <tr key={candidate.code}><td>{candidate.rank}</td><td><strong>{candidate.name}</strong><small>{candidate.code}</small></td><td>{number(candidate.strength, 1)}</td><td>{number(candidate.tradePlan.effectiveTradeability, 1)}</td><td>{statusText[candidate.tradePlan.status]}</td><td>{candidate.tradePlan.executable ? `${candidate.tradePlan.quantity}股` : "ACCOUNT_NOT_EXECUTABLE"}</td><td>{candidate.tradePlan.failedGates.slice(0, 3).join("、") || "进入Final比较池"}</td></tr>)}</tbody></table></div>;
}

function HistorySnapshot({ record, quotes, onDelete }: { record: HistoryRecord; quotes: HistoryQuote[]; onDelete: (id: string) => void }) {
  const candidates = candidatesFromRecord(record) as Array<Record<string, unknown>>;
  const recordQuotes = new Map(quotes.filter((quote) => quote.recordId === record.id).map((quote) => [quote.code, quote]));
  return <article className="history-record"><div className="history-record-head"><div><strong>{new Date(record.scanTime).toLocaleString("zh-CN")}</strong><p>Strategy Version: {record.strategyVersion} · 当时Final {candidates.length}只</p></div><div className="history-record-counts"><button className="ghost-button" onClick={() => onDelete(record.id)}>删除</button></div></div><details><summary>查看当时的最终候选</summary><div className="history-candidates">{candidates.length ? candidates.map((raw, index) => {
    const item = raw as unknown as Candidate & { price?: number; plan?: { stop?: number; target?: number; rr?: number; quantity?: number } };
    const quote = recordQuotes.get(item.code);
    const plan = item.tradePlan || item.plan;
    return <div className="history-candidate" key={`${record.id}-${item.code}`}><div><strong>{item.role || `候选${index + 1}`} · {item.name}</strong><small>{item.code} · 入选价 {number(item.currentPrice ?? item.price)}{quote?.currentPrice == null ? "" : ` · 当前价 ${quote.currentPrice.toFixed(2)}`}</small></div><p>Decision Score {number(item.decisionScore, 1)} · Strength {number(item.strength, 1)} · {plan ? `止损 ${number("stop" in plan ? plan.stop : null)} · 目标 ${number("target1" in plan ? plan.target1 : plan.target)}` : "历史计划数据不足"}</p></div>;
  }) : <p className="muted">当时明确保存的是0候选结论。</p>}</div></details>{Array.isArray(record.internalRadar) ? <details><summary>查看当时Radar研究池</summary><p className="muted">保存了 {(record.internalRadar as unknown[]).length} 只内部Radar快照。</p></details> : null}</article>;
}

export default function Home() {
  const [data, setData] = useState<Scan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyQuotes, setHistoryQuotes] = useState<HistoryQuote[]>([]);
  const [historyMessage, setHistoryMessage] = useState("");
  const [selectedHistoryDate, setSelectedHistoryDate] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setHistory(readInitialHistory()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const historyDates = useMemo(() => [...new Set(history.map((record) => record.scanTime.slice(0, 10)))], [history]);
  const visibleHistory = useMemo(() => selectedHistoryDate ? history.filter((record) => record.scanTime.slice(0, 10) === selectedHistoryDate) : history, [history, selectedHistoryDate]);

  const refreshHistory = useCallback(async (records = history) => {
    const items = records.flatMap((record) => (candidatesFromRecord(record) as Array<Candidate & { price?: number }>).map((candidate) => ({ code: candidate.code, name: candidate.name, entryPrice: candidate.currentPrice ?? candidate.price, selectedAt: record.scanTime, mode: record.mode === "EOD" ? "close" : "entry" }))).filter((item) => item.entryPrice != null);
    if (!items.length) return;
    try {
      const response = await fetch("/api/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
      const payload = await response.json() as { quotes?: Array<{ code: string; currentPrice: number | null; change: number | null; days: number; selectedAt: string }>; error?: string };
      if (!response.ok) throw new Error(payload.error || "历史行情刷新失败");
      setHistoryQuotes((payload.quotes || []).map((quote) => ({ ...quote, recordId: records.find((record) => record.scanTime === quote.selectedAt)?.id || "" })));
      setHistoryMessage(`已更新 ${payload.quotes?.length || 0} 条历史行情`);
    } catch (cause) { setHistoryMessage(cause instanceof Error ? cause.message : "历史行情刷新失败"); }
  }, [history]);

  async function runScan() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "entry" }) });
      const payload = await response.json() as Scan & { error?: string };
      if (!response.ok) throw new Error(payload.error || "扫描失败");
      setData(payload);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "扫描失败"); }
    finally { setLoading(false); }
  }

  function saveCurrentScan() {
    if (!data) return;
    const record = recordFromScan(data) as HistoryRecord;
    const records = dedupeRecords([record, ...history]) as HistoryRecord[];
    localStorage.setItem(V6_HISTORY_KEY, JSON.stringify(records));
    setHistory(records);
    setSelectedHistoryDate(record.scanTime.slice(0, 10));
    setHistoryMessage(`已保存本次 V6.0.1 决策：Final ${data.finalCandidates.length}只，Radar ${data.internalRadar.length}只`);
  }

  function deleteHistory(id: string) {
    const next = removeRecord(history, id) as HistoryRecord[];
    localStorage.setItem(V6_HISTORY_KEY, JSON.stringify(next));
    setHistory(next);
    setHistoryQuotes((quotes) => quotes.filter((quote) => quote.recordId !== id));
    setHistoryMessage("已删除一条历史记录；其他记录未受影响。");
  }

  function clearV6History() {
    localStorage.setItem(V6_HISTORY_KEY, "[]");
    setHistory([]);
    setHistoryQuotes([]);
    setHistoryMessage("已清除 V6 历史记录。");
  }

  const finalTitle = data?.marketPhase === "OPEN_AUCTION" ? "竞价最优候选" : "今日最优候选";

  return <main>
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">CTS</span><span>短线决策台</span></a><div className="source-status">数据源：同花顺问财 · CTS V6.0.1</div></header>
    <section className="hero"><p className="eyebrow">CHEN TRADING SYSTEM · V6.0.1</p><h1>研究全市场，<br />只留下最值得做的。</h1><p className="hero-copy">系统内部覆盖全市场并研究Radar Top20，最终只给出0～3只满足强度、交易性、净盈亏比、账户执行和交易阶段约束的候选。不会为了凑数量降低标准。</p><button className="primary-button" onClick={() => void runScan()} disabled={loading}>{loading ? "扫描中…" : "运行全市场决策扫描"}</button><p className="privacy-note">API Key只在服务端使用；交易计划与最终排名均由确定性规则生成。</p></section>
    {error ? <div className="notice error">{error}</div> : null}
    {!data && !loading ? <section className="empty-state"><div><h2>等待第一次扫描</h2><p>扫描后先看最终0～3只；Radar研究池默认折叠。</p></div></section> : null}
    {loading ? <section className="loading-panel"><p>正在分页覆盖全市场、计算双评分、统一交易计划与最终决策…</p></section> : null}
    {data ? <section className="results">
      <div className="decision-health-grid">
        <div><span>市场状态</span><strong>{data.market.state}</strong></div>
        <div><span>市场阶段</span><strong>{data.marketPhaseLabel}</strong></div>
        <div><span>数据状态</span><strong className={data.dataHealth.status === "ERROR" ? "negative" : data.dataHealth.status === "DEGRADED" ? "amber" : "positive"}>{data.dataHealth.status}</strong></div>
        <div><span>扫描时间</span><strong>{time(data.scanTime)}</strong></div>
        <div><span>行情数据时间</span><strong>{data.dataHealth.quoteTimeStatus}</strong></div>
        <div><span>全市场覆盖率</span><strong>{percent(data.universeCoverage.coverageRatio)}</strong></div>
      </div>
      {data.warning ? <div className="notice">{data.warning}</div> : null}
      {data.dataHealth.warnings.map((warning) => <div className="notice" key={warning}>{warning}</div>)}
      <section className="final-section"><div className="result-heading"><div><p className="eyebrow">FINAL DECISION · 0—3</p><h2>{finalTitle}</h2></div><p>Final {data.finalCandidates.length}只 · Executable Pool {data.funnel.executablePool}只 · 内部Radar {data.internalRadar.length}只</p></div>
        {data.finalCandidates.length ? <div className="final-candidate-list">{data.finalCandidates.map((candidate) => <FinalCandidateCard candidate={candidate} key={candidate.code} />)}</div> : <div className="no-candidates"><strong>当前没有值得执行的短线候选。</strong><p>系统不会为了凑数量降低标准。</p></div>}
      </section>
      <section className="comparison-section"><div className="result-heading"><div><p className="eyebrow">WHY THESE NAMES</p><h2>为什么今天是这{data.finalCandidates.length}只</h2></div></div>{data.finalCandidates.length ? <div className="comparison-list">{data.finalCandidates.map((candidate) => <p key={candidate.code}><b>{candidate.role} · {candidate.name}</b>{candidate.decisionExplanation?.whyRankedHere}</p>)}</div> : <p className="muted">没有股票同时通过覆盖率、交易计划、账户执行、净盈亏比和交易阶段门槛。</p>}</section>
      <details className="diagnostic-panel"><summary>算法诊断 / 查看Radar研究池</summary><div className="coverage-details"><p>Universe {data.funnel.universe} → Fetched {data.funnel.fetched} → Unique {data.funnel.unique} → 有效行情 {data.funnel.validData} → 基础可交易 {data.funnel.eligible} → 完成评分 {data.funnel.scored} → Radar {data.funnel.radar} → Executable Pool {data.funnel.executablePool} → Final {data.funnel.final}</p><p>页数 {data.universeCoverage.pageCount} · 截断 {data.universeCoverage.truncated ? "是" : "否"} · Provider Limit {data.universeCoverage.providerLimitDetected ? "检测到并已翻页" : "未检测到"} · 核心字段完整度 {percent(data.dataHealth.coreFieldCompleteness)}</p></div><RadarPool candidates={data.internalRadar} /></details>
      <div className="history-actions"><button className="secondary-button" onClick={saveCurrentScan}>保存本次选股</button><span>保存Final 0～3、Decision Score、统一TradePlan、解释、覆盖率和内部Radar快照</span></div>
    </section> : null}
    <section className="history-panel"><div className="result-heading"><div><p className="eyebrow">SELECTION JOURNAL</p><h2>选股历史</h2></div><div className="history-tools"><select className="history-date-select" value={selectedHistoryDate} onChange={(event) => setSelectedHistoryDate(event.target.value)}><option value="">全部日期</option>{historyDates.map((date) => <option key={date} value={date}>{date}</option>)}</select><button className="secondary-button" onClick={() => void refreshHistory()} disabled={!history.length}>刷新当前表现</button><button className="ghost-button" onClick={clearV6History} disabled={!history.length}>清除V6记录</button></div></div><p className="history-hint">V6.0历史记录暂保存在当前浏览器；V6.1将升级为云端策略历史。旧的6.0.0快照保持原样，不会重算或覆盖。</p>{historyMessage ? <p className="history-message">{historyMessage}</p> : null}{visibleHistory.length ? <div className="history-record-list">{visibleHistory.map((record) => <HistorySnapshot key={record.id} record={record} quotes={historyQuotes} onDelete={deleteHistory} />)}</div> : <div className="history-empty">还没有记录。运行一次筛选后，点击“保存本次选股”。</div>}</section>
    <footer><p>本工具用于个人交易系统验证，不构成收益承诺。</p><span>Strategy Version: 6.0.1 · CTS V6.0.1</span></footer>
  </main>;
}

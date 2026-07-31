"use client";

import { useMemo, useState } from "react";

type Candidate = {
  code: string;
  name: string;
  price: number;
  change: number;
  sector: string;
  score: number;
  status: "可执行" | "等待确认" | "观察";
  reasons: string[];
  risks: string[];
  entry: number;
  stop: number;
  target: number;
  quantity: number;
  amount: number;
  cost: number;
  holding: string;
  exit: string;
  cancel: string;
};

type ScanResponse = {
  asOf: string;
  source: string;
  mode: "entry" | "close";
  market: {
    state: string;
    upRatio: number | null;
    indexChange: number | null;
    note: string;
  };
  universeCount: number;
  candidates: Candidate[];
  warning?: string;
};

const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0,
});

export default function Home() {
  const [mode, setMode] = useState<"entry" | "close">("entry");
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function runScan(nextMode = mode) {
    setMode(nextMode);
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
      });
      const payload = (await response.json()) as ScanResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || "查询失败，请稍后重试");
      setData(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "查询失败");
    } finally {
      setLoading(false);
    }
  }

  const actionable = useMemo(
    () => data?.candidates.filter((item) => item.status === "可执行").length ?? 0,
    [data],
  );

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">CTS</span>
          <span>短线决策台</span>
        </a>
        <div className="source-status">
          <span className="pulse" />
          数据源：同花顺问财
        </div>
      </header>

      <section className="hero">
        <div className="eyebrow">CHEN TRADING SYSTEM · V5</div>
        <h1>不是找涨得最多的，<br />而是找现在值得买的。</h1>
        <p className="hero-copy">
          全市场实时筛选，自动计入A股T+1、100股一手、最低佣金、印花税和跳空风险。
          每个结果都必须回答：为什么买、怎么买、拿多久、什么时候卖。
        </p>
        <div className="mode-switch" aria-label="选择筛选模式">
          <button
            className={mode === "entry" ? "active" : ""}
            onClick={() => void runScan("entry")}
            disabled={loading}
          >
            <small>盘中</small>
            现在可买
          </button>
          <button
            className={mode === "close" ? "active" : ""}
            onClick={() => void runScan("close")}
            disabled={loading}
          >
            <small>收盘后</small>
            次日候选
          </button>
        </div>
        <button className="primary-button" onClick={() => void runScan()} disabled={loading}>
          {loading ? <span className="spinner" /> : <span>运行全市场筛选</span>}
          {!loading && <span aria-hidden="true">→</span>}
        </button>
        <p className="privacy-note">API Key只在服务端使用，不会发送到浏览器或写入选股记录。</p>
      </section>

      {error && <div className="notice error">{error}</div>}

      {!data && !loading && (
        <section className="empty-state">
          <div className="radar">
            <span />
            <span />
            <span />
            <i />
          </div>
          <div>
            <h2>等待第一次扫描</h2>
            <p>建议交易时段使用“现在可买”，收盘后使用“次日候选”。</p>
          </div>
        </section>
      )}

      {loading && (
        <section className="loading-panel">
          <div className="scan-line" />
          <p>正在检查市场环境、板块强度、量价位置与事件风险…</p>
        </section>
      )}

      {data && !loading && (
        <section className="results">
          <div className="market-strip">
            <div>
              <span>市场状态</span>
              <strong className={data.market.state === "退潮" ? "negative" : "positive"}>
                {data.market.state}
              </strong>
            </div>
            <div>
              <span>上涨家数占比</span>
              <strong>{data.market.upRatio == null ? "—" : `${(data.market.upRatio * 100).toFixed(1)}%`}</strong>
            </div>
            <div>
              <span>纳入初筛</span>
              <strong>{data.universeCount}只</strong>
            </div>
            <div>
              <span>当前可执行</span>
              <strong>{actionable}只</strong>
            </div>
            <div className="timestamp">
              <span>数据时间</span>
              <strong>{new Date(data.asOf).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</strong>
            </div>
          </div>

          <div className="result-heading">
            <div>
              <p className="eyebrow">{mode === "entry" ? "INTRADAY ENTRY" : "NEXT-DAY WATCHLIST"}</p>
              <h2>{mode === "entry" ? "此刻的交易结论" : "下一交易日观察名单"}</h2>
            </div>
            <p>{data.market.note}</p>
          </div>

          {data.warning && <div className="notice">{data.warning}</div>}

          {data.candidates.length === 0 ? (
            <div className="no-candidates">
              <strong>当前没有满足完整条件的股票</strong>
              <p>这不是系统故障。没有合适买点时，现金也是仓位。</p>
            </div>
          ) : (
            <div className="candidate-grid">
              {data.candidates.map((stock, index) => (
                <article className="stock-card" key={stock.code}>
                  <div className="stock-head">
                    <div className="rank">{String(index + 1).padStart(2, "0")}</div>
                    <div>
                      <h3>{stock.name}</h3>
                      <p>{stock.code} · {stock.sector}</p>
                    </div>
                    <span className={`status ${stock.status === "可执行" ? "ready" : ""}`}>
                      {stock.status}
                    </span>
                  </div>

                  <div className="quote-row">
                    <strong>{stock.price.toFixed(2)}</strong>
                    <span className={stock.change >= 0 ? "positive" : "negative"}>
                      {stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)}%
                    </span>
                    <span className="score">评分 {stock.score.toFixed(1)}</span>
                  </div>

                  <div className="thesis">
                    <h4>为什么入选</h4>
                    <ul>{stock.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                  </div>

                  <div className="trade-levels">
                    <div><span>买入上限</span><strong>{stock.entry.toFixed(2)}</strong></div>
                    <div><span>结构止损</span><strong className="negative">{stock.stop.toFixed(2)}</strong></div>
                    <div><span>第一目标</span><strong className="positive">{stock.target.toFixed(2)}</strong></div>
                  </div>

                  <div className="position-row">
                    <div>
                      <span>建议仓位</span>
                      <strong>{stock.quantity}股 · {money.format(stock.amount)}</strong>
                    </div>
                    <div>
                      <span>预计往返成本</span>
                      <strong>约{stock.cost.toFixed(1)}元</strong>
                    </div>
                  </div>

                  <details>
                    <summary>查看持有、卖出与风险规则</summary>
                    <div className="rules">
                      <p><b>持有：</b>{stock.holding}</p>
                      <p><b>卖出：</b>{stock.exit}</p>
                      <p><b>取消：</b>{stock.cancel}</p>
                      <p><b>风险：</b>{stock.risks.join("；")}</p>
                    </div>
                  </details>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <footer>
        <p>本工具用于执行和验证个人交易系统，不构成收益承诺。最终成交由你确认。</p>
        <span>CTS V5 · 本地安全运行</span>
      </footer>
    </main>
  );
}

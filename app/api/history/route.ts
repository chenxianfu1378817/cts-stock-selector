import { NextResponse } from "next/server";
import { env } from "cloudflare:workers";
import { randomBytes } from "node:crypto";
import { currentPriceFrom, findQuoteRow } from "./quote-utils";

type HistoryItem = { code: string; name: string; entryPrice: number; selectedAt: string; mode: "entry" | "close" };

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { items?: HistoryItem[] };
    const items = (body.items || []).filter((item) => item.code && Number.isFinite(item.entryPrice)).slice(0, 100);
    if (!items.length) return NextResponse.json({ quotes: [] });
    const bindings = env as unknown as Record<string, string | undefined>;
    const apiKey = bindings.IWENCAI_API_KEY?.trim();
    if (!apiKey) throw new Error("服务端尚未配置问财 API Key");
    const baseUrl = (bindings.IWENCAI_BASE_URL || "https://openapi.iwencai.com").replace(/\/$/, "");
    const names = items.map((item) => `${item.name}(${item.code.match(/\d{6}/)?.[0] || item.code})`).join("、");
    const response = await fetch(`${baseUrl}/v1/query2data`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Claw-Call-Type": "normal",
        "X-Claw-Skill-Id": "hithink-market-query",
        "X-Claw-Skill-Version": "1.0.0",
        "X-Claw-Plugin-Id": "none",
        "X-Claw-Plugin-Version": "none",
        "X-Claw-Trace-Id": randomBytes(32).toString("hex"),
      },
      body: JSON.stringify({ query: `${names}最新价、今日涨跌幅`, page: "1", limit: String(items.length + 5), is_cache: "0", expand_index: "true" }),
    });
    if (!response.ok) throw new Error(`问财接口返回 ${response.status}`);
    const payload = (await response.json()) as { datas?: Record<string, unknown>[] };
    const rows = payload.datas || [];
    const quotes = items.map((item) => {
      const row = findQuoteRow(rows, item.code);
      const currentPrice = currentPriceFrom(row);
      const change = currentPrice == null ? null : (currentPrice / item.entryPrice - 1) * 100;
      return { ...item, currentPrice, change, days: Math.max(0, Math.floor((Date.now() - new Date(item.selectedAt).getTime()) / 86400000)) };
    });
    return NextResponse.json({ asOf: new Date().toISOString(), quotes });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "历史表现查询失败" }, { status: 500 });
  }
}

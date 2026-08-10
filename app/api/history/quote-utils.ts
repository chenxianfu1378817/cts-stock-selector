type QuoteRow = Record<string, unknown>;

const PRICE_KEY_PATTERNS = [
  /^最新价(?:$|\[|:|_)/,
  /^收盘价(?:$|\[|:|_)/,
];

function numericValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/,/g, "").replace(/元$/, "");
  if (!cleaned || cleaned === "--" || cleaned === "—") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function normalizeStockCode(value: unknown): string {
  return String(value ?? "").trim().match(/\d{6}/)?.[0] || "";
}

export function findQuoteRow(rows: QuoteRow[], code: string): QuoteRow {
  const normalized = normalizeStockCode(code);
  return rows.find((row) => normalizeStockCode(row["股票代码"]) === normalized) || {};
}

export function currentPriceFrom(row: QuoteRow): number | null {
  for (const pattern of PRICE_KEY_PATTERNS) {
    for (const [key, raw] of Object.entries(row)) {
      if (!pattern.test(key)) continue;
      const value = numericValue(raw);
      if (value != null && value > 0) return value;
    }
  }
  return null;
}

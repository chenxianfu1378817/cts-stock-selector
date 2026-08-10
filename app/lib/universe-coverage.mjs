import { STRATEGY_V6 } from "./strategy-v6.config.mjs";

export function coverageStatus(coverage) {
  if (!coverage || coverage.expectedUniverse < STRATEGY_V6.coverage.minExpectedUniverse || coverage.coverageRatio < STRATEGY_V6.coverage.degraded) return "ERROR";
  if (coverage.coverageRatio < STRATEGY_V6.coverage.ok || coverage.truncated) return "DEGRADED";
  return "OK";
}

export async function fetchPaginatedUniverse(fetchPage, options = {}) {
  const pageSize = options.pageSize ?? STRATEGY_V6.coverage.pageSize;
  const maxPages = options.maxPages ?? STRATEGY_V6.coverage.maxPages;
  const symbolFrom = options.symbolFrom ?? ((row) => String(row?.code ?? "").trim());
  const first = await fetchPage(1, pageSize);
  const expectedUniverse = Number(first.count) || first.rows?.length || 0;
  const plannedPages = Math.max(1, Math.min(maxPages, Math.ceil(expectedUniverse / pageSize)));
  const remainingPages = Array.from({ length: Math.max(0, plannedPages - 1) }, (_, index) => index + 2);
  const rest = [];
  if (options.sequentialPages) {
    for (const page of remainingPages) rest.push(await fetchPage(page, pageSize));
  } else {
    rest.push(...await Promise.all(remainingPages.map((page) => fetchPage(page, pageSize))));
  }
  const pages = [first, ...rest];
  const fetchedSymbols = pages.reduce((sum, page) => sum + (page.rows?.length || 0), 0);
  const unique = new Map();
  for (const page of pages) {
    for (const row of page.rows || []) {
      const symbol = symbolFrom(row);
      if (symbol && !unique.has(symbol)) unique.set(symbol, row);
    }
  }
  const uniqueSymbols = unique.size;
  const coverageRatio = expectedUniverse > 0 ? uniqueSymbols / expectedUniverse : 0;
  const providerLimitDetected = expectedUniverse > (first.rows?.length || 0);
  const truncated = uniqueSymbols < expectedUniverse || plannedPages >= maxPages && expectedUniverse > pageSize * maxPages;
  return {
    rows: [...unique.values()],
    coverage: {
      expectedUniverse,
      fetchedSymbols,
      uniqueSymbols,
      coverageRatio,
      pageCount: pages.length,
      truncated,
      providerLimitDetected,
    },
  };
}

export function rebaseUniverseCoverage(result, expectedUniverse) {
  const expected = Math.max(0, Number(expectedUniverse) || 0);
  const uniqueSymbols = result?.coverage?.uniqueSymbols || 0;
  return {
    ...result,
    coverage: {
      ...result.coverage,
      expectedUniverse: expected,
      coverageRatio: expected > 0 ? uniqueSymbols / expected : 0,
      truncated: Boolean(result?.coverage?.truncated) || uniqueSymbols < expected,
    },
  };
}

export function mergeUniverseResults(results, symbolFrom = (row) => String(row?.code ?? "").trim()) {
  const unique = new Map();
  for (const result of results || []) {
    for (const row of result?.rows || []) {
      const symbol = symbolFrom(row);
      if (symbol && !unique.has(symbol)) unique.set(symbol, row);
    }
  }
  const expectedUniverse = (results || []).reduce((sum, result) => sum + (result?.coverage?.expectedUniverse || 0), 0);
  const fetchedSymbols = (results || []).reduce((sum, result) => sum + (result?.coverage?.fetchedSymbols || 0), 0);
  const pageCount = (results || []).reduce((sum, result) => sum + (result?.coverage?.pageCount || 0), 0);
  const uniqueSymbols = unique.size;
  return {
    rows: [...unique.values()],
    coverage: {
      expectedUniverse,
      fetchedSymbols,
      uniqueSymbols,
      coverageRatio: expectedUniverse > 0 ? uniqueSymbols / expectedUniverse : 0,
      pageCount,
      truncated: (results || []).some((result) => result?.coverage?.truncated) || uniqueSymbols < expectedUniverse,
      providerLimitDetected: (results || []).some((result) => result?.coverage?.providerLimitDetected),
    },
  };
}

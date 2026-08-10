import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("contains the CTS V6.0.1 decision-first UI and server-only Wen-Cai route", async () => {
  const [page, layout, route, history, strategy] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/scan/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/history-v6.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/strategy-v6.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /CTS 短线决策台/);
  assert.match(page, /研究全市场/);
  assert.match(page, /最终只给出0～3只/);
  assert.match(page, /运行全市场决策扫描/);
  assert.match(page, /Radar Top20/);
  assert.match(page, /FINAL DECISION/);
  assert.match(page, /统一交易计划/);
  assert.match(page, /净盈亏比（含费用\/滑点）/);
  assert.match(page, /算法诊断 \/ 查看Radar研究池/);
  assert.match(page, /<details className="diagnostic-panel">/);
  assert.match(page, /保存本次选股/);
  assert.match(page, /SELECTION JOURNAL/);
  assert.match(history, /cts-selection-journal-v6/);
  assert.match(page, /还没有记录。运行一次筛选后，点击/);
  assert.match(page, /V6\.0历史记录暂保存在当前浏览器；V6\.1将升级为云端策略历史。/);
  assert.match(page, /旧的6\.0\.0快照保持原样，不会重算或覆盖。/);
  assert.doesNotMatch(page, /现在可买|次日候选/);
  assert.doesNotMatch(page, /V5|v5|不会自动清空|cts-selection-history|historyMigration/);
  assert.doesNotMatch(history, /V5|v5|LEGACY|MIGRATION|cts-selection-history/);
  assert.match(route, /queryPage\("hithink-market-query"/);
  assert.doesNotMatch(route, /hithink-astock-selector/);
  assert.match(route, /fetchPaginatedUniverse/);
  assert.match(route, /buildTradePlan/);
  assert.match(strategy, /export function buildTradePlan/);
  assert.match(route, /IWENCAI_API_KEY/);
  assert.doesNotMatch(page, /IWENCAI_API_KEY|sk-proj-/);
  assert.doesNotMatch(layout, /codex-preview|SkeletonPreview/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("contains the CTS product UI and server-only Wen-Cai route", async () => {
  const [page, layout, route] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/scan/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /CTS 短线决策台/);
  assert.match(page, /不是找涨得最多的/);
  assert.match(page, /现在可买/);
  assert.match(page, /次日候选/);
  assert.match(page, /运行全市场筛选/);
  assert.match(route, /hithink-astock-selector/);
  assert.match(route, /IWENCAI_API_KEY/);
  assert.doesNotMatch(page, /IWENCAI_API_KEY|sk-proj-/);
  assert.doesNotMatch(layout, /codex-preview|SkeletonPreview/);
});

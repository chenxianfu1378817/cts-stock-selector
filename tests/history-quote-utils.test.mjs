import assert from "node:assert/strict";
import test from "node:test";
import { currentPriceFrom, findQuoteRow, normalizeStockCode } from "../app/api/history/quote-utils.ts";

test("prefers an actual latest-price field over helper fields containing the same words", () => {
  const row = {
    "股票代码": "002185.SZ",
    "最新价连续为0天": 0,
    "最新价:前复权": 17.12,
  };
  assert.equal(currentPriceFrom(row), 17.12);
});

test("parses a price carrying a yuan suffix", () => {
  assert.equal(currentPriceFrom({ "最新价[20260807]": "23.88元" }), 23.88);
});

test("matches quote rows by six-digit code regardless of exchange suffix", () => {
  const rows = [{ "股票代码": "002241", "最新价": 24.01 }];
  assert.equal(findQuoteRow(rows, "002241.SZ")["最新价"], 24.01);
  assert.equal(normalizeStockCode("SH600460"), "600460");
});

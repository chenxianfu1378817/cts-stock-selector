export const V6_HISTORY_KEY = "cts-selection-journal-v6";

const safeText = (value) => String(value ?? "").trim();
const validDate = (value) => {
  const text = safeText(value);
  return text && Number.isFinite(new Date(text).getTime()) ? text : "";
};

export function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function savedCandidates(record) {
  if (Array.isArray(record?.finalCandidates)) return record.finalCandidates;
  if (Array.isArray(record?.candidates)) return record.candidates;
  return [];
}

function snapshotKey(record) {
  const codes = savedCandidates(record).map((item) => safeText(item?.code)).filter(Boolean).sort();
  return [safeText(record?.strategyVersion), safeText(record?.mode), safeText(record?.scanTime), codes.join(",")].join("|");
}

export function isV6Record(record) {
  return record && typeof record === "object" && record.schemaVersion === "v6" &&
    /^6\.0\.\d+$/.test(safeText(record.strategyVersion)) && validDate(record.scanTime) &&
    (record.mode === "INTRADAY" || record.mode === "EOD") &&
    (Array.isArray(record.finalCandidates) || Array.isArray(record.candidates));
}

export function dedupeRecords(records) {
  const seen = new Set();
  return (Array.isArray(records) ? records : []).filter((record) => {
    if (!isV6Record(record)) return false;
    const identity = snapshotKey(record);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((a, b) => safeText(b.scanTime).localeCompare(safeText(a.scanTime)));
}

function parseArray(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function readV6History(storage) {
  return dedupeRecords(parseArray(storage, V6_HISTORY_KEY));
}

export function recordFromScan(scan) {
  const scanTime = validDate(scan?.scanTime) || new Date().toISOString();
  const finalCandidates = Array.isArray(scan?.finalCandidates) ? scan.finalCandidates : [];
  const internalRadar = Array.isArray(scan?.internalRadar) ? scan.internalRadar : [];
  const identity = [scan.strategyVersion, scan.mode, scanTime, finalCandidates.map((item) => item.code).sort().join(",")].join("|");
  return {
    id: `v6-${stableHash(identity)}`,
    schemaVersion: "v6",
    strategyVersion: scan.strategyVersion,
    scanTime,
    mode: scan.mode,
    marketPhase: scan.marketPhase,
    marketPhaseLabel: scan.marketPhaseLabel,
    coverage: scan.universeCoverage,
    dataHealth: scan.dataHealth,
    funnel: scan.funnel,
    finalCandidates,
    decisionScores: finalCandidates.map((item) => ({ code: item.code, decisionScore: item.decisionScore })),
    tradePlans: finalCandidates.map((item) => ({ code: item.code, tradePlan: item.tradePlan })),
    decisionExplanations: finalCandidates.map((item) => ({ code: item.code, decisionExplanation: item.decisionExplanation })),
    internalRadar,
  };
}

export function candidatesFromRecord(record) {
  return savedCandidates(record);
}

export function removeRecord(records, id) {
  return (Array.isArray(records) ? records : []).filter((record) => record.id !== id);
}

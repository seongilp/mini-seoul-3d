/**
 * 역별·시간대별 승하차 인원을 모아 public/data/ridership.json 을 만든다.
 *
 * 출처는 서울 열린데이터광장 CardSubwayTime(지하철 시간대별 이용현황).
 * 월 합계로 오므로 일평균으로 바꿔서 저장한다.
 *
 *   node scripts/build-ridership.mjs [YYYYMM]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "http://openapi.seoul.go.kr:8088";
const SERVICE = "CardSubwayTime";
/** 한 번에 받을 행수. 서버가 500행 넘게 요청하면 오류를 준다. */
const PAGE = 500;
/** 최신 월은 집계가 늦어 비어 있을 수 있다. 이만큼 거슬러 올라가며 찾는다. */
const MONTHS_BACK = 6;

function readKey() {
  if (process.env.SUBWAY) return process.env.SUBWAY;
  for (const path of [join(root, ".env"), join(homedir(), ".env")]) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0 || trimmed.slice(0, eq).trim() !== "SUBWAY") continue;
      return trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
    }
  }
  throw new Error("SUBWAY 인증키를 찾지 못했습니다.");
}

function normalize(name) {
  return (
    String(name || "")
      .replace(/\(.*?\)/g, "")
      .replace(/[·.]/g, "")
      .replace(/\s+/g, "")
      .replace(/역$/, "") || String(name || "")
  );
}

/** 개명·표기 차이. API 이름 → network.json 이름(둘 다 정규화 형태). */
const ALIASES = { 불암산: "당고개", 이수: "총신대입구" };

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchMonth(key, month) {
  const rows = [];
  for (let start = 1; ; start += PAGE) {
    const body = await getJson(`${HOST}/${key}/json/${SERVICE}/${start}/${start + PAGE - 1}/${month}/`);
    const payload = body?.[SERVICE];
    if (!payload || payload.RESULT?.CODE !== "INFO-000") break;
    const page = payload.row ?? [];
    rows.push(...page);
    if (rows.length >= payload.list_total_count || page.length === 0) break;
  }
  return rows;
}

function daysInMonth(month) {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(4, 6));
  return new Date(year, m, 0).getDate();
}

async function main() {
  const key = readKey();
  const network = JSON.parse(readFileSync(join(root, "public/data/network.json"), "utf8"));

  // 인자로 월을 주지 않으면 최근 달부터 데이터가 있는 달을 찾는다.
  let month = process.argv[2];
  let rows = [];
  if (month) {
    rows = await fetchMonth(key, month);
  } else {
    const now = new Date();
    for (let back = 1; back <= MONTHS_BACK; back++) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const candidate = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      rows = await fetchMonth(key, candidate);
      if (rows.length > 0) {
        month = candidate;
        break;
      }
    }
  }
  if (!rows.length) throw new Error("이용현황 데이터를 받지 못했습니다.");
  console.log(`${month}: ${rows.length}행`);

  const byName = new Map();
  for (const station of network.stations) byName.set(normalize(station.name), station);

  const days = daysInMonth(month);
  /** stationId → { on: number[24], off: number[24] } */
  const totals = new Map();
  /** 같은 (노선, 역) 행이 두 번씩 오므로 한 번만 센다. */
  const seen = new Set();
  const unmatched = new Set();

  for (const row of rows) {
    const dedupeKey = `${row.SBWY_ROUT_LN_NM}|${row.STTN}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const raw = normalize(row.STTN);
    const station = byName.get(ALIASES[raw] ?? raw) ?? byName.get(raw);
    if (!station) {
      unmatched.add(`${row.SBWY_ROUT_LN_NM}:${row.STTN}`);
      continue;
    }

    let entry = totals.get(station.id);
    if (!entry) {
      entry = { on: new Array(24).fill(0), off: new Array(24).fill(0) };
      totals.set(station.id, entry);
    }
    // 환승역은 노선마다 개찰 집계가 따로 오므로 더해서 역 전체 이용객으로 만든다.
    for (let hour = 0; hour < 24; hour++) {
      entry.on[hour] += Number(row[`HR_${hour}_GET_ON_NOPE`]) || 0;
      entry.off[hour] += Number(row[`HR_${hour}_GET_OFF_NOPE`]) || 0;
    }
  }

  const stations = {};
  let peak = 0;
  for (const [id, entry] of totals) {
    const on = entry.on.map((v) => Math.round(v / days));
    const off = entry.off.map((v) => Math.round(v / days));
    for (let h = 0; h < 24; h++) peak = Math.max(peak, on[h] + off[h]);
    stations[id] = { on, off };
  }

  const result = {
    month,
    generatedAt: new Date().toISOString(),
    note: "on/off 는 시간대별(0~23시) 일평균 승차·하차 인원.",
    peak,
    stations,
  };
  const path = join(root, "public/data/ridership.json");
  writeFileSync(path, JSON.stringify(result));
  const kb = Math.round(readFileSync(path).length / 1024);
  console.log(
    `완료: 역 ${Object.keys(stations).length}개, 미매칭 ${unmatched.size}건, 시간당 최대 ${peak.toLocaleString()}명, ${kb}KB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

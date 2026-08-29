/**
 * 서울교통공사 지하철혼잡도정보 CSV 를 public/data/congestion.json 으로 바꾼다.
 *
 * 원본은 raw/congestion.csv (CP949). 30분 단위 39개 구간에 역·방향별 혼잡도가
 * 백분율로 들어 있다. 100 이 정원이고 그 위는 입석까지 찬 상태다.
 *
 *   node scripts/build-congestion.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "raw/congestion.csv");
const OUT = join(root, "public/data/congestion.json");

/** CSV 호선 표기 → network.json 노선 id. 서울교통공사 소속만 있다. */
const LINE_MAP = {
  "1호선": "1",
  "2호선": "2",
  "3호선": "3",
  "4호선": "4",
  "5호선": "5",
  "6호선": "6",
  "7호선": "7",
  "8호선": "8",
};

const DAY_MAP = { 평일: "weekday", 토요일: "saturday", 일요일: "holiday" };

/**
 * 방향 표기 → 역번호가 늘어나는 쪽인지.
 * 창동 하선 아침 75.8(도심행), 사당 외선 아침 142.4(강남행)로 확인했다.
 */
const ASCENDING = { 하선: true, 내선: true, 상선: false, 외선: false };

/**
 * CSV 쪽 표기가 다른 역. 값도 정규화된 형태로 적는다.
 * 성수E / 응암S 는 지선 표기라 본선 역으로 합친다.
 */
const ALIASES = {
  불암산: "당고개",
  이수: "총신대입구",
  성수E: "성수",
  응암S: "응암",
};

function normalize(name) {
  return (
    String(name || "")
      .replace(/\(.*?\)/g, "")
      .replace(/[·.]/g, "")
      .replace(/\s+/g, "")
      .replace(/역$/, "") || String(name || "")
  );
}

/** CP949 로 저장된 원본을 읽는다. */
function readCsv(path) {
  const buffer = readFileSync(path);
  const text = new TextDecoder("euc-kr").decode(buffer);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

/** "5시30분" → "05:30" */
function toClock(label) {
  const m = /^(\d{1,2})시(\d{2})분$/.exec(label);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

function main() {
  const rows = readCsv(SOURCE);
  const header = Object.keys(rows[0]);
  const timeCols = header.filter((h) => toClock(h));
  const times = timeCols.map(toClock);
  console.log(`행 ${rows.length}, 시간대 ${times.length}개 (${times[0]}~${times[times.length - 1]})`);

  const network = JSON.parse(readFileSync(join(root, "public/data/network.json"), "utf8"));

  // (노선, 정규화 역명) → 우리 역
  const byLineName = new Map();
  for (const station of network.stations) {
    for (const line of station.lines) {
      byLineName.set(`${line}|${normalize(station.name)}`, station);
    }
  }

  /**
   * 우리 route 의 배열 순서가 역번호 증가 방향인지 판정한다.
   * 이걸 알아야 CSV 의 상선·하선을 우리 dir(+1/-1) 로 옮길 수 있다.
   */
  const codeByLineName = new Map();
  for (const row of rows) {
    const line = LINE_MAP[row.호선];
    if (!line) continue;
    const raw = normalize(row.출발역);
    const key = `${line}|${ALIASES[raw] ?? raw}`;
    const code = Number(row.역번호);
    if (!Number.isFinite(code)) continue;
    const seen = codeByLineName.get(key);
    if (seen) seen.add(code);
    else codeByLineName.set(key, new Set([code]));
  }

  /** routeId → 배열 순서가 역번호 증가 방향이면 true */
  const ascendingByRoute = new Map();
  for (const route of network.routes) {
    const line = route.line;
    if (!Object.values(LINE_MAP).includes(line)) continue;

    const codes = [];
    for (const stop of route.stations) {
      const set = codeByLineName.get(`${line}|${normalize(stop.name)}`);
      if (!set) continue;
      // 지선 때문에 한 이름에 번호가 여럿일 수 있다. 앞선 값과 가까운 쪽을 쓴다.
      const prev = codes.length ? codes[codes.length - 1] : null;
      const pick =
        prev === null
          ? Math.min(...set)
          : [...set].sort((a, b) => Math.abs(a - prev) - Math.abs(b - prev))[0];
      codes.push(pick);
    }
    if (codes.length < 2) continue;

    let up = 0;
    for (let i = 1; i < codes.length; i++) {
      if (codes[i] > codes[i - 1]) up += 1;
      else if (codes[i] < codes[i - 1]) up -= 1;
    }
    ascendingByRoute.set(route.id, up >= 0);
  }

  // 노선 단위로 방향을 정한다. 같은 노선의 route 들은 방향이 같다고 본다.
  const ascendingByLine = new Map();
  for (const route of network.routes) {
    const value = ascendingByRoute.get(route.id);
    if (value === undefined) continue;
    if (!ascendingByLine.has(route.line)) ascendingByLine.set(route.line, value);
  }
  console.log("배열 순서가 역번호 증가 방향인 노선:", [...ascendingByLine].map(([l, v]) => `${l}:${v}`).join(" "));

  // stationId → line → day → { forward, backward }
  const out = {};
  const unmatched = new Set();
  let filled = 0;

  for (const row of rows) {
    const line = LINE_MAP[row.호선];
    const day = DAY_MAP[row.요일구분];
    const ascends = ASCENDING[row.상하구분];
    if (!line || !day || ascends === undefined) continue;

    const raw = normalize(row.출발역);
    const station = byLineName.get(`${line}|${ALIASES[raw] ?? raw}`) ?? byLineName.get(`${line}|${raw}`);
    if (!station) {
      unmatched.add(`${row.호선}:${row.출발역}`);
      continue;
    }

    const values = timeCols.map((col) => {
      const v = Number(row[col]);
      return Number.isFinite(v) ? Math.round(v) : 0;
    });
    if (values.every((v) => v === 0)) continue;

    // CSV 의 방향을 우리 dir 로 옮긴다.
    const routeAscends = ascendingByLine.get(line) ?? true;
    const forward = ascends === routeAscends;

    const byStation = (out[station.id] ??= {});
    const byLine = (byStation[line] ??= {});
    const byDay = (byLine[day] ??= {});
    byDay[forward ? "forward" : "backward"] = values;
    filled += 1;
  }

  const result = {
    source: "서울교통공사 지하철혼잡도정보 (20260331)",
    note: "혼잡도 백분율. 100 이 정원. forward 는 route.stations 배열 순방향(dir=1).",
    times,
    stations: out,
  };
  writeFileSync(OUT, JSON.stringify(result));
  const kb = Math.round(readFileSync(OUT).length / 1024);
  console.log(
    `완료: 역 ${Object.keys(out).length}개, 항목 ${filled}건, 미매칭 ${unmatched.size}건, ${kb}KB`,
  );
  if (unmatched.size) console.log("  미매칭:", [...unmatched].slice(0, 10).join(", "));
}

main();

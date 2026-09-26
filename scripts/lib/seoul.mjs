/**
 * 서울 열린데이터광장 지하철 API 를 부르는 스크립트들이 함께 쓰는 도구.
 * build-timetable.mjs, build-runtimes.mjs 가 쓴다.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const HOST = "http://openapi.seoul.go.kr:8088";
/** 동시 요청 수. 상대는 공공 API 서버라 과하게 밀어붙이지 않는다. */
const CONCURRENCY = 6;
const RETRIES = 3;

/** API 노선명 → network.json 노선 id. */
export const LINE_MAP = {
  "01호선": "1",
  "02호선": "2",
  "03호선": "3",
  "04호선": "4",
  "05호선": "5",
  "06호선": "6",
  "07호선": "7",
  "08호선": "8",
  "09호선": "9",
  경의선: "K",
  경춘선: "G",
  공항철도: "A",
  수인분당선: "B",
  신분당선: "S",
  경강선: "KK",
  우이신설경전철: "UI",
  서해선: "W",
  인천선: "I",
  인천2호선: "I2",
  의정부경전철: "U",
  용인경전철: "E",
  김포도시철도: "GG",
};

/**
 * 한 노선의 역이 network.json 에서는 다른 노선에 속하는 경우.
 * 수인분당선 남부 구간이 우리 데이터에서는 수인선(SU)으로 갈려 있다.
 */
export const FALLBACK_LINES = { B: ["SU"] };

/** 개명된 역. API 가 새 이름, network.json 이 옛 이름을 쓰는 경우. */
export const RENAMED = { 불암산: "당고개" };

export function readKey() {
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
  throw new Error("SUBWAY 인증키를 찾지 못했습니다. 환경변수나 .env 에 넣어 주세요.");
}

export function normalize(name) {
  return (
    String(name || "")
      .replace(/\(.*?\)/g, "")
      .replace(/[·.]/g, "")
      .replace(/\s+/g, "")
      .replace(/역$/, "") || String(name || "")
  );
}

export async function getJson(url) {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt === RETRIES - 1) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

/** 응답 봉투에서 목록 페이로드를 꺼낸다. 오류면 null. */
export function unwrap(body, service) {
  const payload = body?.[service];
  if (!payload) return null;
  if (payload.RESULT?.CODE && payload.RESULT.CODE !== "INFO-000") return null;
  return payload;
}

export async function fetchStationCodes(key) {
  const body = await getJson(`${HOST}/${key}/json/SearchInfoBySubwayNameService/1/999/`);
  const payload = unwrap(body, "SearchInfoBySubwayNameService");
  if (!payload) throw new Error("역 코드 목록을 받지 못했습니다.");
  return payload.row;
}

/** 작업 목록을 제한된 동시성으로 실행한다. */
export async function runPool(items, worker, onProgress) {
  const results = [];
  let index = 0;
  let done = 0;

  async function run() {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
      done += 1;
      if (done % 200 === 0) onProgress?.(done, items.length);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  return results;
}

/**
 * API 역코드를 우리 역에 맞춘다. 환승역은 노선마다 코드가 따로라
 * 우리 역 하나에 여러 코드가 붙을 수 있다.
 */
export function matchStations(codes, network) {
  const byLineName = new Map();
  for (const station of network.stations) {
    for (const line of station.lines) {
      byLineName.set(`${line}|${normalize(station.name)}`, station);
    }
  }

  const targets = [];
  const unmatched = new Set();
  for (const row of codes) {
    const line = LINE_MAP[row.LINE_NUM];
    if (!line) continue;
    const name = normalize(RENAMED[row.STATION_NM] ?? row.STATION_NM);

    let station = byLineName.get(`${line}|${name}`);
    if (!station) {
      for (const alt of FALLBACK_LINES[line] ?? []) {
        station = byLineName.get(`${alt}|${name}`);
        if (station) break;
      }
    }
    if (!station) {
      unmatched.add(`${row.LINE_NUM}:${row.STATION_NM}`);
      continue;
    }
    targets.push({ code: row.STATION_CD, line, stationId: station.id });
  }
  return { targets, unmatched };
}

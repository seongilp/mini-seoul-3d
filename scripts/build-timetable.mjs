/**
 * 역별 첫차·막차 시각을 모아 public/data/timetable.json 을 만든다.
 *
 * 전체 시간표는 역·요일·방향 조합당 약 200행이라 다 합치면 85만 행이 넘는다.
 * 브라우저로 보낼 수 있는 크기가 아니라서 각 조합의 첫 행과 마지막 행만 남긴다.
 *
 *   node scripts/build-timetable.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "http://openapi.seoul.go.kr:8088";
/** 동시 요청 수. 상대는 공공 API 서버라 과하게 밀어붙이지 않는다. */
const CONCURRENCY = 6;
/** 한 조합의 최대 행수. 실측 최대가 240 정도라 넉넉하다. */
const ROW_LIMIT = 600;
const RETRIES = 3;

/** 요일 구분. API 의 WEEK_TAG 값. */
const WEEK_TAGS = { weekday: "1", saturday: "2", holiday: "3" };
/** 방향. API 의 INOUT_TAG 값. 1 = 상행/내선, 2 = 하행/외선. */
const INOUT_TAGS = { up: "1", down: "2" };

/** API 노선명 → network.json 노선 id. */
const LINE_MAP = {
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
const FALLBACK_LINES = { B: ["SU"] };

/** 개명된 역. API 가 새 이름, network.json 이 옛 이름을 쓰는 경우. */
const RENAMED = { 불암산: "당고개" };

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
  throw new Error("SUBWAY 인증키를 찾지 못했습니다. 환경변수나 .env 에 넣어 주세요.");
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

async function getJson(url) {
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
function unwrap(body, service) {
  const payload = body?.[service];
  if (!payload) return null;
  if (payload.RESULT?.CODE && payload.RESULT.CODE !== "INFO-000") return null;
  return payload;
}

/**
 * "05:36:00" → "05:36". 자정 이후는 "24:46" 표기를 그대로 둔다.
 *
 * "00:00:00" 은 시각이 아니라 "해당 없음" 이다. 그 역에서 운행을 마치는 열차는
 * LEFTTIME 이, 그 역에서 출발하는 열차는 ARRIVETIME 이 이 값으로 온다.
 */
function hhmm(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ""));
  if (!m) return null;
  const value = `${m[1].padStart(2, "0")}:${m[2]}`;
  return value === "00:00" ? null : value;
}

/** 정렬·비교용 분 단위 값. 자정 이후 "24:46" 은 1486 이 된다. */
function toMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

async function fetchStationCodes(key) {
  const body = await getJson(`${HOST}/${key}/json/SearchInfoBySubwayNameService/1/999/`);
  const payload = unwrap(body, "SearchInfoBySubwayNameService");
  if (!payload) throw new Error("역 코드 목록을 받지 못했습니다.");
  return payload.row;
}

/**
 * 한 조합의 첫차·막차를 가져온다.
 *
 * 승객이 그 역에서 탈 수 있는 열차를 기준으로 하므로 출발 시각(LEFTTIME)만 본다.
 * 그 역에서 운행을 마치는 열차는 출발 시각이 없어 제외된다.
 *
 * 응답이 LEFTTIME 문자열 순으로 정렬돼 오는데 "00:00:00"(출발 없음)이 맨 앞에
 * 섞이므로 순서를 믿지 않고 전체를 받아 직접 최소·최대를 고른다.
 */
async function fetchEdges(key, code, week, inout) {
  const base = `${HOST}/${key}/json/SearchSTNTimeTableByIDService`;
  const payload = unwrap(
    await getJson(`${base}/1/${ROW_LIMIT}/${code}/${week}/${inout}/`),
    "SearchSTNTimeTableByIDService",
  );
  if (!payload?.row?.length) return null;

  let first = null;
  let last = null;
  for (const row of payload.row) {
    const time = hhmm(row.LEFTTIME);
    if (!time) continue;
    const minutes = toMinutes(time);
    if (minutes === null) continue;

    const entry = { time, minutes, dest: row.SUBWAYENAME || "" };
    if (!first || minutes < first.minutes) first = entry;
    if (!last || minutes > last.minutes) last = entry;
  }
  if (!first || !last) return null;

  return [first.time, first.dest, last.time, last.dest];
}

/** 작업 목록을 제한된 동시성으로 실행한다. */
async function runPool(items, worker, onProgress) {
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

async function main() {
  const key = readKey();
  const network = JSON.parse(readFileSync(join(root, "public/data/network.json"), "utf8"));

  // (노선, 정규화 역명) → 우리 역
  const byLineName = new Map();
  for (const station of network.stations) {
    for (const line of station.lines) {
      byLineName.set(`${line}|${normalize(station.name)}`, station);
    }
  }

  const codes = await fetchStationCodes(key);
  console.log(`역 코드 ${codes.length}건`);

  /** 우리 역 하나가 여러 API 역코드에 대응할 수 있다(환승역). 노선별로 따로 담는다. */
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
  console.log(`매칭 ${targets.length}건, 미매칭 ${unmatched.size}건`);

  const jobs = [];
  for (const target of targets) {
    for (const [weekName, weekTag] of Object.entries(WEEK_TAGS)) {
      for (const [dirName, inoutTag] of Object.entries(INOUT_TAGS)) {
        jobs.push({ ...target, weekName, weekTag, dirName, inoutTag });
      }
    }
  }
  console.log(`조회 ${jobs.length}건 시작…`);

  const edges = await runPool(
    jobs,
    async (job) => {
      try {
        return await fetchEdges(key, job.code, job.weekTag, job.inoutTag);
      } catch {
        return null;
      }
    },
    (done, total) => console.log(`  ${done}/${total}`),
  );

  // stationId → line → week → { up, down }
  const out = {};
  let filled = 0;
  jobs.forEach((job, i) => {
    const edge = edges[i];
    if (!edge) return;
    const station = (out[job.stationId] ??= {});
    const line = (station[job.line] ??= {});
    const week = (line[job.weekName] ??= {});
    week[job.dirName] = edge;
    filled += 1;
  });

  const result = {
    generatedAt: new Date().toISOString(),
    note: "각 항목은 [첫차, 첫차 종착역, 막차, 막차 종착역]. 24:xx 는 자정 이후.",
    stations: out,
  };
  const path = join(root, "public/data/timetable.json");
  writeFileSync(path, JSON.stringify(result));
  const kb = Math.round(readFileSync(path).length / 1024);
  console.log(`완료: 역 ${Object.keys(out).length}개, 항목 ${filled}건, ${kb}KB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

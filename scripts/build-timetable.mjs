/**
 * 역별 첫차·막차 시각을 모아 public/data/timetable.json 을 만든다.
 *
 * 전체 시간표는 역·요일·방향 조합당 약 200행이라 다 합치면 85만 행이 넘는다.
 * 브라우저로 보낼 수 있는 크기가 아니라서 각 조합의 첫 행과 마지막 행만 남긴다.
 *
 *   node scripts/build-timetable.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchStationCodes,
  getJson,
  HOST,
  matchStations,
  readKey,
  root,
  runPool,
  unwrap,
} from "./lib/seoul.mjs";

/** 한 조합의 최대 행수. 실측 최대가 240 정도라 넉넉하다. */
const ROW_LIMIT = 600;

/** 요일 구분. API 의 WEEK_TAG 값. */
const WEEK_TAGS = { weekday: "1", saturday: "2", holiday: "3" };
/** 방향. API 의 INOUT_TAG 값. 1 = 상행/내선, 2 = 하행/외선. */
const INOUT_TAGS = { up: "1", down: "2" };

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

async function main() {
  const key = readKey();
  const network = JSON.parse(readFileSync(join(root, "public/data/network.json"), "utf8"));

  const codes = await fetchStationCodes(key);
  console.log(`역 코드 ${codes.length}건`);

  /** 우리 역 하나가 여러 API 역코드에 대응할 수 있다(환승역). 노선별로 따로 담는다. */
  const { targets, unmatched } = matchStations(codes, network);
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

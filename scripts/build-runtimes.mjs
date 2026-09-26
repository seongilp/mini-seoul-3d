/**
 * 역 사이 운행 시간과 역별 정차 시간을 모아 public/data/runtimes.json 을 만든다.
 *
 * 역별 시간표에는 열차번호와 도착·출발 시각이 있다. 같은 열차번호를 시각순으로
 * 이으면 그 열차가 어느 역을 떠나 다음 역에 언제 닿는지 나온다. 이것을 모든
 * 열차에 대해 모아 구간마다 평균을 낸다.
 *
 * 시각이 30초 단위라 열차 하나로는 거칠지만, 수백 대를 평균하면 실제 값에
 * 가까워진다. 평일 시간표만 쓴다. 주말도 역 사이 시간은 거의 같다.
 *
 *   node scripts/build-runtimes.mjs
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

const ROW_LIMIT = 600;
const WEEKDAY = "1";
const INOUT_TAGS = ["1", "2"];

/** 이보다 짧거나 긴 구간 값은 자료 오류나 이어 붙이기 실수로 본다. */
const MIN_RUN_SEC = 30;
const MAX_RUN_SEC = 900;
/** 정차가 이보다 길면 회차·대기라 정차 시간 평균에서 뺀다. */
const MAX_DWELL_SEC = 180;
/** 구간 하나에 이만큼은 모여야 믿는다. */
const MIN_SAMPLES = 5;

/** "05:36:30" → 초. "00:00:00" 은 "해당 없음" 이라 null. */
function seconds(time) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(time || ""));
  if (!m) return null;
  const value = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return value === 0 ? null : value;
}

async function fetchRows(key, code, inout) {
  const base = `${HOST}/${key}/json/SearchSTNTimeTableByIDService`;
  const payload = unwrap(
    await getJson(`${base}/1/${ROW_LIMIT}/${code}/${WEEKDAY}/${inout}/`),
    "SearchSTNTimeTableByIDService",
  );
  return payload?.row ?? [];
}

/**
 * 튀는 값을 버린 평균. 중앙값의 절반~1.5배 밖은 버린다.
 * 30초 단위로 잘린 값들이라 중앙값만 쓰면 30초 계단이 그대로 남는다.
 */
function robustMean(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const kept = sorted.filter((v) => v >= median * 0.5 && v <= median * 1.5);
  return kept.reduce((sum, v) => sum + v, 0) / kept.length;
}

/** 같은 열차의 정차 기록을 시각순으로 이어 구간·정차 표본을 모은다. */
function collect(stops, runs, dwells) {
  const byTrain = new Map();
  for (const stop of stops) {
    const key = `${stop.line}|${stop.inout}|${stop.train}`;
    const list = byTrain.get(key);
    if (list) list.push(stop);
    else byTrain.set(key, [stop]);
  }

  const push = (map, key, value) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  for (const list of byTrain.values()) {
    list.sort((a, b) => (a.arrive ?? a.leave) - (b.arrive ?? b.leave));
    for (let i = 0; i < list.length; i++) {
      const here = list[i];
      if (here.arrive !== null && here.leave !== null) {
        const dwell = here.leave - here.arrive;
        if (dwell >= 0 && dwell <= MAX_DWELL_SEC) push(dwells, `${here.line}|${here.stationId}`, dwell);
      }

      const next = list[i + 1];
      if (!next || here.leave === null || next.arrive === null) continue;
      if (here.stationId === next.stationId) continue;
      const run = next.arrive - here.leave;
      if (run < MIN_RUN_SEC || run > MAX_RUN_SEC) continue;
      push(runs, `${here.line}|${here.stationId}|${next.stationId}`, run);
    }
  }
}

function summarize(map) {
  const out = {};
  for (const [key, values] of map) {
    if (values.length < MIN_SAMPLES) continue;
    out[key] = Math.round(robustMean(values));
  }
  return out;
}

async function main() {
  const key = readKey();
  const network = JSON.parse(readFileSync(join(root, "public/data/network.json"), "utf8"));

  const codes = await fetchStationCodes(key);
  const { targets, unmatched } = matchStations(codes, network);
  console.log(`역 코드 ${codes.length}건, 매칭 ${targets.length}건, 미매칭 ${unmatched.size}건`);

  const jobs = targets.flatMap((target) => INOUT_TAGS.map((inout) => ({ ...target, inout })));
  console.log(`조회 ${jobs.length}건 시작…`);

  let failed = 0;
  const results = await runPool(
    jobs,
    async (job) => {
      try {
        return await fetchRows(key, job.code, job.inout);
      } catch {
        failed += 1;
        return [];
      }
    },
    (done, total) => console.log(`  ${done}/${total}`),
  );

  const stops = [];
  jobs.forEach((job, i) => {
    for (const row of results[i]) {
      // 급행은 역을 건너뛰어 이웃한 역 사이 시간이 아니다.
      if (row.EXPRESS_YN && row.EXPRESS_YN !== "G") continue;
      stops.push({
        line: job.line,
        inout: job.inout,
        train: row.TRAIN_NO,
        stationId: job.stationId,
        arrive: seconds(row.ARRIVETIME),
        leave: seconds(row.LEFTTIME),
      });
    }
  });

  const runs = new Map();
  const dwells = new Map();
  collect(stops, runs, dwells);

  const result = {
    generatedAt: new Date().toISOString(),
    note: "runs: '노선|출발역|도착역' → 운행 초, dwells: '노선|역' → 정차 초. 평일 시간표 평균.",
    runs: summarize(runs),
    dwells: summarize(dwells),
  };
  const path = join(root, "public/data/runtimes.json");
  writeFileSync(path, JSON.stringify(result));
  const kb = Math.round(readFileSync(path).length / 1024);
  console.log(
    `완료: 구간 ${Object.keys(result.runs).length}개, 정차 ${Object.keys(result.dwells).length}개, ` +
      `실패 ${failed}건, ${kb}KB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

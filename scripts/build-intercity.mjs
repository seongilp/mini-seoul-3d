/**
 * KTX·SRT 노선 형상과 운행 패턴을 public/data/intercity.json 으로 만든다.
 *
 *   node scripts/build-intercity.mjs
 *
 * 형상과 역 좌표는 OpenStreetMap(Overpass)에서 받는다. 한 번 받으면 raw/ 에
 * 두고 다시 쓴다. 새로 받으려면 raw/intercity-*.json 을 지우고 돌린다.
 *
 * 운행 시각은 실제 시간표가 아니다. 노선별 소요 시간과 배차 간격을 어림한
 * 값으로, 화면에 보이는 열차 위치는 추정이다. 공공데이터포털 TAGO 열차정보
 * API 키가 생기면 SERVICES 의 duration/headway 대신 실제 시각을 넣으면 된다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_ROUTES = resolve(root, "raw/intercity-routes.json");
const RAW_STATIONS = resolve(root, "raw/intercity-stations.json");
const OUT = resolve(root, "public/data/intercity.json");
const OVERPASS = "https://overpass-api.de/api/interpreter";
const KOREA_BBOX = "33.0,124.5,38.7,131.0";

const KTX_COLOR = "#1F4E9E";
const SRT_COLOR = "#7A1F4B";

/**
 * 운행 계통. relations 는 OSM 노선 관계 id 이고, 선로는 그 순서대로 잇는다.
 * OSM 관계가 중간까지만 그려진 계통은 뒤쪽을 본선 관계로 이어 붙인다
 * (SRT 는 평택에서 본선에 합류한다).
 *
 * 강릉선·동해선(포항)·경전선·중앙선은 OSM 관계가 일부 구간만 그려져 있어 뺐다.
 * durationMin 은 기점에서 종점까지 걸리는 시간, headwayMin 은 배차 간격,
 * first/last 는 기점 첫차·막차 출발 시각. 모두 어림값이다.
 */
const SERVICES = [
  {
    id: "ktx-gyeongbu",
    name: "KTX 경부선",
    operator: "KTX",
    relations: [11214334],
    stops: ["서울", "광명", "천안아산", "오송", "대전", "김천(구미)", "동대구", "경주", "울산", "부산"],
    durationMin: 160,
    headwayMin: 20,
    first: "05:15",
    last: "23:00",
  },
  {
    id: "srt-gyeongbu",
    name: "SRT 경부선",
    operator: "SRT",
    relations: [11214688, 11214334],
    join: "merge",
    stops: ["수서", "동탄", "평택지제", "천안아산", "오송", "대전", "김천(구미)", "동대구", "경주", "울산", "부산"],
    durationMin: 150,
    headwayMin: 30,
    first: "05:30",
    last: "22:40",
  },
  {
    id: "ktx-honam",
    name: "KTX 호남선",
    operator: "KTX",
    relations: [11272646],
    stops: ["용산", "광명", "천안아산", "오송", "공주", "익산", "정읍", "광주송정", "나주", "목포"],
    durationMin: 155,
    headwayMin: 45,
    first: "05:10",
    last: "22:25",
  },
  {
    id: "srt-honam",
    name: "SRT 호남선",
    operator: "SRT",
    relations: [11214690, 11272646],
    join: "merge",
    stops: ["수서", "동탄", "평택지제", "천안아산", "오송", "공주", "익산", "정읍", "광주송정", "나주", "목포"],
    durationMin: 145,
    headwayMin: 60,
    first: "05:40",
    last: "22:40",
  },
  {
    id: "ktx-jeolla",
    name: "KTX 전라선",
    operator: "KTX",
    relations: [11272647],
    stops: ["용산", "광명", "천안아산", "오송", "공주", "익산", "전주", "남원", "곡성", "구례구", "순천", "여천", "여수엑스포"],
    durationMin: 185,
    headwayMin: 60,
    first: "05:10",
    last: "21:50",
  },
];

/** 역이 선로에서 이보다 멀면(m) 그 노선의 역이 아니라고 본다. */
const STATION_MAX_OFFSET_M = 900;
/** 형상을 줄일 때 허용하는 오차(m). */
const SIMPLIFY_TOLERANCE_M = 6;
/** 역 정차 시간(초). */
const DWELL_SEC = 120;
/** 가감속 손실을 거리로 환산한 값(m). 짧은 구간일수록 평균 속도가 낮아지게 한다. */
const STOP_PENALTY_M = 9000;
/** 한 편성 칸 수. KTX-산천·SRT 기준. */
const CARS = 10;

async function overpass(query) {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "osm-route-fetch/1.0",
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

async function cached(path, query) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  console.log(`fetching ${path}`);
  const data = await overpass(query);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
  return data;
}

const toRad = (deg) => (deg * Math.PI) / 180;

function haversine(a, b) {
  const R = 6371000;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 관계에 든 선로 조각을 순서대로 이어 한 줄로 만든다. 조각 방향은 앞뒤를 보고 맞춘다. */
function stitch(relation) {
  const ways = relation.members
    .filter((m) => m.type === "way" && m.geometry)
    .map((m) => m.geometry.map((p) => [p.lon, p.lat]));
  if (ways.length === 0) throw new Error(`relation ${relation.id}: 선로가 없습니다`);

  const line = [];
  ways.forEach((way, i) => {
    let seg = way;
    if (i === 0) {
      const next = ways[1];
      if (next) {
        const tailFits = Math.min(haversine(way.at(-1), next[0]), haversine(way.at(-1), next.at(-1)));
        const headFits = Math.min(haversine(way[0], next[0]), haversine(way[0], next.at(-1)));
        if (headFits < tailFits) seg = [...way].reverse();
      }
    } else if (haversine(line.at(-1), way.at(-1)) < haversine(line.at(-1), way[0])) {
      seg = [...way].reverse();
    }
    for (const p of seg) {
      const prev = line.at(-1);
      if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) line.push(p);
    }
  });
  return line;
}

/** 두 선로가 이 거리(m) 안에 있으면 같은 선로를 달리는 것으로 본다. */
const SHARED_TRACK_M = 40;

/** 이음매 앞뒤로 이만큼 떨어진 점을 보고 뒤 노선의 진행 방향을 가린다. */
const SEAM_PROBE_POINTS = 20;

/**
 * 앞 노선과 뒤 노선을 이어 붙인다.
 *
 * merge: 앞 노선이 뒤 노선에 합류한다(SRT 가 평택에서 본선에 들어서는 경우).
 *        앞 노선에서 뒤 노선과 처음 겹치는 점이 이음매다.
 * split: 앞 노선에서 뒤 노선이 갈라져 나간다(포항행이 본선을 떠나는 경우).
 *        앞 노선에서 뒤 노선과 마지막으로 겹치는 점이 이음매다.
 */
function join(head, tail, mode) {
  const tailDist = cumulative(tail);
  const order = head.map((_, i) => (mode === "merge" ? i : head.length - 1 - i));
  const seam = order.find((i) => project(tail, tailDist, head[i]).offset <= SHARED_TRACK_M);
  if (seam === undefined) throw new Error("이어 붙일 두 노선이 만나지 않습니다");
  const seamAlong = project(tail, tailDist, head[seam]).along;

  // 겹쳐 달리는 구간의 다른 점 하나를 뒤 노선에 내려 보면 어느 쪽이 앞인지 알 수 있다.
  const probeIndex =
    mode === "merge"
      ? Math.min(head.length - 1, seam + SEAM_PROBE_POINTS)
      : Math.max(0, seam - SEAM_PROBE_POINTS);
  const probe = project(tail, tailDist, head[probeIndex]);
  const shared = probe.offset <= SHARED_TRACK_M && Math.abs(probe.along - seamAlong) > 1;
  const forward = shared
    ? mode === "merge"
      ? probe.along > seamAlong
      : probe.along < seamAlong
    : seamAlong < tailDist.at(-1) / 2;

  const rest = forward
    ? tail.filter((_, i) => tailDist[i] > seamAlong)
    : tail.filter((_, i) => tailDist[i] < seamAlong).reverse();
  return [...head.slice(0, seam + 1), ...rest];
}

/** 서울 부근 기준의 평면 좌표(m). 줄이기와 투영에만 쓴다. */
function planar(p) {
  return [p[0] * 111320 * Math.cos(toRad(36.5)), p[1] * 110540];
}

function pointSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return { t, dist: Math.hypot(p[0] - x, p[1] - y) };
}

/** Douglas–Peucker. 재귀 대신 스택으로 돈다(점이 수만 개라 재귀가 깊어진다). */
function simplify(coords, tolerance) {
  const flat = coords.map(planar);
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    let worst = -1;
    let worstDist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegment(flat[i], flat[a], flat[b]).dist;
      if (d > worstDist) {
        worst = i;
        worstDist = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return coords.filter((_, i) => keep[i] === 1);
}

function cumulative(coords) {
  const dist = [0];
  for (let i = 1; i < coords.length; i++) dist.push(dist[i - 1] + haversine(coords[i - 1], coords[i]));
  return dist;
}

/** 점을 노선에 내린 자리. along 은 기점부터의 거리(m). */
function project(coords, dist, point) {
  const flat = coords.map(planar);
  const p = planar(point);
  let best = { along: 0, offset: Infinity };
  for (let i = 1; i < coords.length; i++) {
    const hit = pointSegment(p, flat[i - 1], flat[i]);
    if (hit.dist < best.offset) {
      best = { along: dist[i - 1] + hit.t * (dist[i] - dist[i - 1]), offset: hit.dist };
    }
  }
  return best;
}

const baseName = (name) => name.replace(/역$/, "").replace(/\s*\(.*\)$/, "").trim();

/** 이름이 같은 역 가운데 이 노선에 가장 가까운 것. */
function locateStop(name, candidates, coords, dist) {
  const wanted = baseName(name);
  let best = null;
  for (const node of candidates) {
    const tagged = node.tags?.name ?? "";
    if (tagged !== name && baseName(tagged) !== wanted) continue;
    const hit = project(coords, dist, [node.lon, node.lat]);
    if (!best || hit.offset < best.offset) best = hit;
  }
  if (!best || best.offset > STATION_MAX_OFFSET_M) {
    throw new Error(`${name}: 노선 근처에서 역을 찾지 못했습니다 (${best ? Math.round(best.offset) : "없음"}m)`);
  }
  return best.along;
}

/** 구간별 운행 시간(초). 전체 소요 시간을 거리 비율로 나누되 정차 손실을 더한다. */
function runTimes(alongs, durationMin) {
  const gaps = alongs.slice(1).map((a, i) => a - alongs[i]);
  const moving = durationMin * 60 - DWELL_SEC * (alongs.length - 2);
  const weights = gaps.map((g) => g + STOP_PENALTY_M);
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => Math.round((moving * w) / total));
}

function buildService(spec, relations, stationNodes) {
  const full = spec.relations
    .map((id) => {
      const relation = relations.find((r) => r.id === id);
      if (!relation) throw new Error(`${spec.name}: relation ${id} 이 없습니다`);
      return stitch(relation);
    })
    .reduce((head, tail) => join(head, tail, spec.join));
  const fullDist = cumulative(full);
  const located = spec.stops.map((name) => ({
    name,
    along: locateStop(name, stationNodes, full, fullDist),
  }));
  for (let i = 1; i < located.length; i++) {
    if (located[i].along <= located[i - 1].along) {
      throw new Error(`${spec.name}: ${located[i - 1].name} → ${located[i].name} 순서가 노선과 맞지 않습니다`);
    }
  }

  // 기점역 앞과 종점역 뒤의 선로(차량기지 등)는 잘라 낸다.
  const start = located[0].along;
  const end = located.at(-1).along;
  const inside = full.filter((_, i) => fullDist[i] >= start && fullDist[i] <= end);
  const coords = simplify(inside, SIMPLIFY_TOLERANCE_M).map(([lng, lat]) => [
    Number(lng.toFixed(5)),
    Number(lat.toFixed(5)),
  ]);
  const dist = cumulative(coords);
  const length = dist.at(-1);
  // 줄인 형상 위에 역을 다시 내려 along 이 형상과 어긋나지 않게 한다.
  const scale = length / (end - start);
  const stops = located.map((s) => ({
    name: s.name,
    along: Math.round((s.along - start) * scale),
  }));
  stops[stops.length - 1].along = Math.floor(length);

  return {
    id: spec.id,
    name: spec.name,
    operator: spec.operator,
    color: spec.operator === "SRT" ? SRT_COLOR : KTX_COLOR,
    cars: CARS,
    length: Math.round(length),
    coords,
    stops,
    runSec: runTimes(stops.map((s) => s.along), spec.durationMin),
    dwellSec: DWELL_SEC,
    headwayMin: spec.headwayMin,
    first: spec.first,
    last: spec.last,
  };
}

async function main() {
  const ids = [...new Set(SERVICES.flatMap((s) => s.relations))].join(",");
  const routes = await cached(RAW_ROUTES, `[out:json][timeout:180];relation(id:${ids});out geom;`);
  const stations = await cached(
    RAW_STATIONS,
    `[out:json][timeout:180];node[railway~"^(station|halt)$"](${KOREA_BBOX});out;`,
  );

  const services = SERVICES.map((spec) => buildService(spec, routes.elements, stations.elements));
  for (const s of services) {
    const km = (s.length / 1000).toFixed(0);
    const avg = (s.length / 1000 / (s.runSec.reduce((a, b) => a + b, 0) / 3600)).toFixed(0);
    console.log(`${s.name}: ${km}km, 역 ${s.stops.length}곳, 점 ${s.coords.length}개, 주행 평균 ${avg}km/h`);
  }

  writeFileSync(
    OUT,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      note: "형상은 OpenStreetMap. 운행 시각은 실제 시간표가 아니라 소요 시간과 배차 간격을 어림한 값.",
      attribution: "© OpenStreetMap contributors",
      services,
    }),
  );
  console.log(`wrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

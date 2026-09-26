import { cumulative, pointAlong } from "../geo";
import type { Network, Route } from "../types";
import { toMinutes, type Timetable } from "./timetable";

/**
 * 막차 보기에 쓰는 값들. 시각은 모두 운행일 기준 분이다(새벽 0시 30분 = 1470).
 *
 * 역별 시간표에는 "그 역을 떠나는 마지막 열차" 만 있다. 역과 역 사이 구간을
 * 마지막으로 지나는 열차는 양 끝 역의 막차 가운데 늦은 쪽으로 어림한다.
 * 반대 방향 막차까지 섞여 조금 늦게 잡힐 수는 있어도, 아직 열차가 지나가는
 * 구간을 먼저 꺼 버리지는 않는다.
 */

/** 시간표가 없는 구간. 끌 수 없으니 늘 켜 둔다. */
export const NO_SCHEDULE = 9999;

export type LineLast = {
  line: string;
  /** 그 노선에서 가장 늦게 떠나는 열차. 시간표가 없으면 null. */
  last: number | null;
};

/** 노선별 막차. 노선의 모든 역 가운데 가장 늦은 출발이다. */
export function lineLastTrains(network: Network, timetable: Timetable | null, date: Date): LineLast[] {
  return network.lines.map((line) => ({
    line: line.id,
    last: timetable?.windowFor(line.id, date)?.last ?? null,
  }));
}

/** 한 역에서 그 노선의 마지막 출발(방향 무관). 없으면 null. */
function lastAt(timetable: Timetable, stationId: string, line: string, date: Date): number | null {
  let best: number | null = null;
  for (const row of timetable.edgesFor(stationId, date)) {
    if (row.line !== line) continue;
    const minutes = toMinutes(row.edge[2]);
    if (minutes !== null && (best === null || minutes > best)) best = minutes;
  }
  return best;
}

/** 노선 좌표에서 from~to(m) 구간을 잘라 낸다. from < to 여야 한다. */
function slice(route: Route, dist: number[], from: number, to: number): [number, number][] {
  // pointAlong 은 노선 길이로 나눈 나머지를 쓰므로 끝점은 살짝 안쪽으로 당긴다.
  const at = (d: number) =>
    pointAlong(route.coords, dist, route.length, Math.min(d, route.length - 0.01)).coord;
  const inner = route.coords.filter((_, i) => dist[i] > from && dist[i] < to);
  return [at(from), ...inner, at(to)];
}

function routeSegments(route: Route): Array<{ from: string; to: string; coords: [number, number][] }> {
  const dist = cumulative(route.coords);
  const stops = [...route.stations].sort((a, b) => a.along - b.along);
  const out: Array<{ from: string; to: string; coords: [number, number][] }> = [];

  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (b.along - a.along < 1) continue;
    out.push({ from: a.id, to: b.id, coords: slice(route, dist, a.along, b.along) });
  }

  // 순환선은 마지막 역에서 첫 역으로 이어지는 구간이 하나 더 있다.
  if (route.loop && stops.length > 1) {
    const a = stops[stops.length - 1];
    const b = stops[0];
    const tail = slice(route, dist, a.along, route.length);
    const head = b.along > 0 ? slice(route, dist, 0, b.along) : [];
    out.push({ from: a.id, to: b.id, coords: [...tail, ...head] });
  }
  return out;
}

/**
 * 역 사이 구간마다 마지막 열차가 지나는 시각을 담은 GeoJSON.
 * 지도는 이 값을 지금 시각과 비교해 구간을 끄고 켠다.
 */
export function lastRunSegments(
  network: Network,
  timetable: Timetable | null,
  date: Date,
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const color = new Map(network.lines.map((l) => [l.id, l.color]));
  const cache = new Map<string, number | null>();
  const lastOf = (stationId: string, line: string) => {
    const key = `${stationId}|${line}`;
    if (!cache.has(key)) cache.set(key, timetable ? lastAt(timetable, stationId, line, date) : null);
    return cache.get(key) ?? null;
  };

  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  for (const route of network.routes) {
    for (const seg of routeSegments(route)) {
      const a = lastOf(seg.from, route.line);
      const b = lastOf(seg.to, route.line);
      const end = a === null && b === null ? NO_SCHEDULE : Math.max(a ?? 0, b ?? 0);
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: seg.coords },
        properties: { line: route.line, color: color.get(route.line) ?? "#888", end },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

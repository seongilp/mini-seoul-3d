import { cumulative, pointAlong } from "../geo";
import type { LineInfo, Network, Route, RouteStation, SimState } from "../types";

export type Train = {
  id: string;
  routeId: string;
  line: string;
  color: string;
  cars: number;
  /** 행선지(종착역). 지도 라벨에 쓴다. */
  destination: string;
  dir: 1 | -1;
  along: number;
  dwell: number;
  lastStop: number;
  coord: [number, number];
  heading: number;
};

export type PreparedRoute = Route & {
  dist: number[];
  line: string;
  color: string;
  cars: number;
  headway: number;
};

const CRUISE = 15.5;
const DWELL = 14000;

function hourFactor(clockMs: number): number {
  const hour = new Date(clockMs).getHours();
  if (hour >= 1 && hour < 5) return 0.08;
  if (hour < 6) return 0.2;
  if (hour < 7) return 0.45;
  if ((hour >= 7 && hour < 9) || (hour >= 18 && hour < 20)) return 1.15;
  if (hour >= 23) return 0.35;
  return 1;
}

export function prepareRoutes(network: Network): PreparedRoute[] {
  const lines = new Map(network.lines.map((l) => [l.id, l]));
  return network.routes
    .filter((r) => r.stations.length >= 3 && r.length > 1500)
    .map((r) => {
      const line = lines.get(r.line) as LineInfo;
      return {
        ...r,
        dist: cumulative(r.coords),
        color: line.color,
        cars: line.cars,
        headway: line.headway,
      };
    });
}

/** 진행 방향 끝의 역 이름. 순환선은 종착 개념이 없어 내선/외선으로 표기한다. */
function terminalName(route: PreparedRoute, dir: 1 | -1): string {
  if (route.loop) return dir === 1 ? "내선순환" : "외선순환";
  const end = dir === 1 ? route.stations[route.stations.length - 1] : route.stations[0];
  return end ? end.name : "";
}

export function seedTrains(routes: PreparedRoute[], state: SimState): Train[] {
  const trains: Train[] = [];
  const factor = hourFactor(state.clockMs);
  for (const route of routes) {
    if (state.hiddenLines.has(route.line)) continue;
    const spacing = route.headway * 60 * CRUISE;
    let count = Math.max(2, Math.round((route.length / spacing) * factor));
    if (state.eco) count = Math.max(1, Math.round(count * 0.45));
    const dirs: Array<1 | -1> = route.loop ? [1, -1] : [1, -1];
    for (const dir of dirs) {
      const n = Math.max(1, Math.round(count / dirs.length));
      for (let i = 0; i < n; i++) {
        const along = ((i + 0.12) / n) * route.length;
        const pose = pointAlong(route.coords, route.dist, route.length, along);
        trains.push({
          id: `${route.id}:${dir}:${i}`,
          routeId: route.id,
          line: route.line,
          color: route.color,
          cars: route.cars,
          destination: terminalName(route, dir),
          dir,
          along,
          dwell: 0,
          lastStop: -1,
          coord: pose.coord,
          heading: pose.heading,
        });
      }
    }
  }
  return trains;
}

let routeIndex: Map<string, PreparedRoute> | null = null;
let indexedRoutes: PreparedRoute[] | null = null;

function firstCrossedStop(
  route: PreparedRoute,
  from: number,
  dir: 1 | -1,
  moved: number,
  exclude: number,
): RouteStation | null {
  let best: RouteStation | null = null;
  let bestD = Infinity;
  for (const stop of route.stations) {
    if (stop.along === exclude) continue;
    let d = (stop.along - from) * dir;
    if (route.loop) d = ((d % route.length) + route.length) % route.length;
    if (d > 0 && d <= moved && d < bestD) {
      best = stop;
      bestD = d;
    }
  }
  return best;
}

function nearestStop(route: PreparedRoute, along: number): RouteStation | null {
  let best: RouteStation | null = null;
  let bd = Infinity;
  for (const s of route.stations) {
    const d = Math.abs(s.along - along);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return bd < 60 ? best : null;
}

export function stepFleet(
  trains: Train[],
  routes: PreparedRoute[],
  state: SimState,
  dtMs: number,
): void {
  if (indexedRoutes !== routes || !routeIndex) {
    routeIndex = new Map(routes.map((r) => [r.id, r]));
    indexedRoutes = routes;
  }
  const dt = (dtMs / 1000) * state.speed;
  for (const train of trains) {
    const route = routeIndex.get(train.routeId);
    if (!route) continue;
    if (train.dwell > 0) {
      train.dwell -= dtMs * state.speed;
      continue;
    }
    const from = train.along;
    const moved = CRUISE * dt;
    train.along += moved * train.dir;

    if (!route.loop && (train.along >= route.length || train.along <= 0)) {
      const end = train.along >= route.length ? route.length : 0;
      train.along = end;
      train.dir = train.dir === 1 ? -1 : 1;
      train.destination = terminalName(route, train.dir);
      train.dwell = DWELL * 0.7;
      const term = nearestStop(route, end);
      if (term) train.lastStop = term.along;
    } else {
      const stop = firstCrossedStop(route, from, train.dir, moved, train.lastStop);
      if (stop) {
        train.along = stop.along;
        train.lastStop = stop.along;
        train.dwell = DWELL;
      }
    }

    const pose = pointAlong(route.coords, route.dist, route.length, train.along);
    train.coord = pose.coord;
    train.heading = pose.heading;
    if (train.dir === -1) train.heading = (train.heading + 180) % 360;
  }
}

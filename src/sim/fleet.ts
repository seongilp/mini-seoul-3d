import { cumulative, pointAlong } from "../geo";
import type { LineInfo, Network, Route, SimState } from "../types";

export type Train = {
  id: string;
  routeId: string;
  line: string;
  color: string;
  cars: number;
  dir: 1 | -1;
  along: number;
  dwell: number;
  lastStop: number;
  coord: [number, number];
  heading: number;
};

type PreparedRoute = Route & {
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
          cars: 1,
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

export function stepFleet(
  trains: Train[],
  routes: PreparedRoute[],
  state: SimState,
  dtMs: number,
): void {
  const byId = new Map(routes.map((r) => [r.id, r]));
  const dt = (dtMs / 1000) * state.speed;
  for (const train of trains) {
    const route = byId.get(train.routeId);
    if (!route) continue;
    if (train.dwell > 0) {
      train.dwell -= dtMs * state.speed;
      continue;
    }
    train.along += CRUISE * dt * train.dir;
    if (route.loop) {
      train.along = ((train.along % route.length) + route.length) % route.length;
    } else if (train.along >= route.length) {
      train.along = route.length;
      train.dir = -1;
      train.dwell = DWELL * 0.7;
    } else if (train.along <= 0) {
      train.along = 0;
      train.dir = 1;
      train.dwell = DWELL * 0.7;
    } else {
      for (const stop of route.stations) {
        if (stop.along === train.lastStop) continue;
        if (Math.abs(train.along - stop.along) < 12) {
          train.dwell = DWELL;
          train.along = stop.along;
          train.lastStop = stop.along;
          break;
        }
      }
    }
    const pose = pointAlong(route.coords, route.dist, route.length, train.along);
    train.coord = pose.coord;
    train.heading = pose.heading;
    if (train.dir === -1) train.heading = (train.heading + 180) % 360;
  }
}

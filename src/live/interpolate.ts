import { pointAlong } from "../geo";
import type { PreparedRoute, Train } from "../sim/fleet";

/** 이 거리 이상 벌어지면 보간하지 않고 즉시 옮긴다(신규 등장, 회차 등). */
const SNAP_DISTANCE = 3000;
/** 보간 구간 길이의 하한·상한(ms). 폴링이 늦어져도 화면이 굳지 않게 한다. */
const MIN_DURATION = 2_000;
const MAX_DURATION = 90_000;

type Segment = {
  train: Train;
  from: number;
  to: number;
};

/** 순환선에서 되감기는 쪽이 아니라 짧은 쪽으로 이동하도록 델타를 고른다. */
function shortestDelta(route: PreparedRoute, from: number, to: number): number {
  const raw = to - from;
  if (!route.loop) return raw;
  const half = route.length / 2;
  if (raw > half) return raw - route.length;
  if (raw < -half) return raw + route.length;
  return raw;
}

/**
 * 폴링으로 들어온 실시간 위치를 프레임마다 부드럽게 따라가게 한다.
 * 갱신 시점에 순간이동하는 대신, 화면에 보이던 위치에서 새 위치로 이어 준다.
 */
export class LiveFleet {
  private readonly routes = new Map<string, PreparedRoute>();
  private segments: Segment[] = [];
  private startedAt = 0;
  private duration = MIN_DURATION;
  private lastUpdateAt = 0;
  /** 직전 프레임에 실제로 그려진 위치. 다음 보간의 출발점이 된다. */
  private displayed = new Map<string, number>();

  constructor(routes: PreparedRoute[]) {
    for (const route of routes) this.routes.set(route.id, route);
  }

  /** 새 스냅샷을 받는다. atMs 는 수신 시각. */
  update(trains: Train[], atMs: number): void {
    const gap = this.lastUpdateAt === 0 ? MIN_DURATION : atMs - this.lastUpdateAt;
    this.duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, gap));
    this.lastUpdateAt = atMs;
    this.startedAt = atMs;

    this.segments = trains.map((train) => {
      const route = this.routes.get(train.routeId);
      const shown = this.displayed.get(train.id);
      if (shown === undefined || !route) return { train, from: train.along, to: train.along };

      const delta = shortestDelta(route, shown, train.along);
      if (Math.abs(delta) > SNAP_DISTANCE) return { train, from: train.along, to: train.along };
      return { train, from: shown, to: shown + delta };
    });

    // 사라진 열차는 기억에서 지운다.
    const alive = new Set(trains.map((t) => t.id));
    for (const id of this.displayed.keys()) {
      if (!alive.has(id)) this.displayed.delete(id);
    }
  }

  /** 현재 시각에 해당하는 열차 배열을 만든다. 매 프레임 호출한다. */
  sample(nowMs: number): Train[] {
    if (this.segments.length === 0) return [];

    const t = Math.min(1, Math.max(0, (nowMs - this.startedAt) / this.duration));
    const eased = t * t * (3 - 2 * t); // smoothstep

    const out: Train[] = [];
    for (const seg of this.segments) {
      const route = this.routes.get(seg.train.routeId);
      if (!route) continue;

      let along = seg.from + (seg.to - seg.from) * eased;
      if (route.loop) along = ((along % route.length) + route.length) % route.length;
      this.displayed.set(seg.train.id, along);

      const pose = pointAlong(route.coords, route.dist, route.length, along);
      out.push({ ...seg.train, along, coord: pose.coord, heading: pose.heading });
    }
    return out;
  }

  /** 첫 스냅샷을 받았는지. 받기 전에는 기존 시뮬레이션 열차를 그대로 둔다. */
  hasData(): boolean {
    return this.lastUpdateAt !== 0;
  }

  clear(): void {
    this.segments = [];
    this.displayed.clear();
    this.lastUpdateAt = 0;
  }
}

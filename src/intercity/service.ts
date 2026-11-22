import { cumulative, pointAlong } from "../geo";
import type { PreparedRoute, Train, UpcomingStop } from "../sim/fleet";

/**
 * KTX·SRT. 실시간 위치를 주는 공개 API 가 없어, 노선별 소요 시간과 배차 간격을
 * 어림한 운행 패턴(scripts/build-intercity.mjs)으로 지금 어디쯤인지 추정한다.
 *
 * 지하철 시뮬레이션과 달리 상태가 없다. 열차 위치는 시각만으로 정해지므로
 * 시간 막대를 어디로 끌어도 그 시각의 배치가 바로 나온다.
 */
export type IntercityService = {
  id: string;
  name: string;
  operator: "KTX" | "SRT";
  color: string;
  cars: number;
  length: number;
  coords: [number, number][];
  stops: { name: string; along: number }[];
  /** 역 사이 운행 시간(초). stops 보다 하나 적다. */
  runSec: number[];
  dwellSec: number;
  headwayMin: number;
  /** 기점 첫차·막차 출발 시각 "HH:MM". */
  first: string;
  last: string;
};

type IntercityData = { services: IntercityService[] };

const DAY_SEC = 86400;
/** 구간 운행 시간 가운데 가속(또는 감속)에 쓰는 비율의 상한. */
const RAMP_MAX = 0.25;
/** 가속에 걸리는 시간(초). 구간이 짧으면 RAMP_MAX 가 먼저 걸린다. */
const RAMP_SEC = 150;
/** pointAlong 은 길이의 나머지를 쓰므로 종점에서 0 으로 감기지 않게 조금 덜 간다. */
const END_MARGIN_M = 0.5;

/** 한 방향으로 본 계통. 하행은 그대로, 상행은 역과 구간을 뒤집는다. */
type Pattern = {
  service: IntercityService;
  route: PreparedRoute;
  dir: 1 | -1;
  /** 진행 방향으로 잰 역 위치(m). */
  alongs: number[];
  names: string[];
  runSec: number[];
  /** 기점 출발 뒤 각 역에 도착하는 시각(초)과 떠나는 시각(초). */
  arrive: number[];
  depart: number[];
  totalSec: number;
  /** 하루의 기점 출발 시각들(자정 기준 초). */
  departures: number[];
};

function clockSec(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 3600 + m * 60;
}

function isService(value: unknown): value is IntercityService {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.color === "string" &&
    typeof s.length === "number" &&
    Array.isArray(s.coords) &&
    Array.isArray(s.stops) &&
    Array.isArray(s.runSec) &&
    s.stops.length >= 2 &&
    s.runSec.length === s.stops.length - 1 &&
    typeof s.headwayMin === "number" &&
    s.headwayMin > 0 &&
    typeof s.first === "string" &&
    typeof s.last === "string"
  );
}

function toRoute(service: IntercityService): PreparedRoute {
  return {
    id: service.id,
    line: service.id,
    loop: false,
    coords: service.coords,
    length: service.length,
    stations: service.stops.map((s, index) => ({
      id: `${service.id}:${index}`,
      name: s.name,
      along: s.along,
      index,
    })),
    dist: cumulative(service.coords),
    color: service.color,
    cars: service.cars,
    headway: service.headwayMin,
  };
}

function toPattern(service: IntercityService, route: PreparedRoute, dir: 1 | -1): Pattern {
  const forward = dir === 1;
  const stops = forward ? service.stops : [...service.stops].reverse();
  const runSec = forward ? service.runSec : [...service.runSec].reverse();
  const alongs = stops.map((s) => (forward ? s.along : service.length - s.along));

  const arrive = [0];
  const depart = [0];
  runSec.forEach((run, i) => {
    const at = depart[i] + run;
    arrive.push(at);
    depart.push(at + service.dwellSec);
  });

  const first = clockSec(service.first);
  const last = clockSec(service.last);
  const step = service.headwayMin * 60;
  // 상·하행이 같은 시각에 떠나지 않게 반 간격 어긋나게 한다.
  const offset = forward ? 0 : Math.round(step / 2);
  const departures: number[] = [];
  for (let t = first + offset; t <= last; t += step) departures.push(t);

  return {
    service,
    route,
    dir,
    alongs,
    names: stops.map((s) => s.name),
    runSec,
    arrive,
    depart,
    totalSec: arrive[arrive.length - 1],
    departures,
  };
}

/** 가속 → 순항 → 감속. u 는 구간 시간의 진행률(0~1), 돌려주는 값은 거리 진행률. */
function ease(u: number, ramp: number): number {
  const scale = 2 * ramp * (1 - ramp);
  if (u < ramp) return (u * u) / scale;
  if (u > 1 - ramp) return 1 - ((1 - u) * (1 - u)) / scale;
  return (u - ramp / 2) / (1 - ramp);
}

/** 그 진행률에서의 속도 배율(평균 속도 = 1). */
function easeRate(u: number, ramp: number): number {
  const peak = 1 / (1 - ramp);
  if (u < ramp) return (u / ramp) * peak;
  if (u > 1 - ramp) return ((1 - u) / ramp) * peak;
  return peak;
}

type Progress = {
  /** 진행 방향으로 잰 위치(m). */
  along: number;
  speed: number;
  /** 지나온(또는 서 있는) 역의 순번. */
  stopIndex: number;
  /** 역에 서 있으면 남은 정차 시간(초). 달리는 중이면 0. */
  dwellLeft: number;
};

function progressAt(pattern: Pattern, elapsed: number): Progress {
  const last = pattern.alongs.length - 1;
  for (let i = 0; i < last; i++) {
    if (elapsed < pattern.depart[i]) {
      return { along: pattern.alongs[i], speed: 0, stopIndex: i, dwellLeft: pattern.depart[i] - elapsed };
    }
    if (elapsed < pattern.arrive[i + 1]) {
      const run = pattern.runSec[i];
      const gap = pattern.alongs[i + 1] - pattern.alongs[i];
      const u = (elapsed - pattern.depart[i]) / run;
      const ramp = Math.min(RAMP_MAX, RAMP_SEC / run);
      return {
        along: pattern.alongs[i] + gap * ease(u, ramp),
        speed: (gap / run) * easeRate(u, ramp),
        stopIndex: i,
        dwellLeft: 0,
      };
    }
  }
  return { along: pattern.alongs[last], speed: 0, stopIndex: last, dwellLeft: 0 };
}

export class Intercity {
  readonly services: IntercityService[];
  readonly routes: PreparedRoute[];
  private readonly patterns: Pattern[];
  private readonly byTrain = new Map<string, { pattern: Pattern; elapsed: number }>();

  constructor(services: IntercityService[]) {
    this.services = services;
    this.routes = services.map(toRoute);
    this.patterns = services.flatMap((service, i) => [
      toPattern(service, this.routes[i], 1),
      toPattern(service, this.routes[i], -1),
    ]);
  }

  static async load(url = "/data/intercity.json"): Promise<Intercity> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Partial<IntercityData>;
    if (!Array.isArray(data.services)) throw new Error("intercity.json 형식이 맞지 않습니다");
    const services = data.services.filter(isService);
    if (services.length === 0) throw new Error("intercity.json 에 쓸 수 있는 계통이 없습니다");
    return new Intercity(services);
  }

  /** 그 시각에 달리고 있는 열차들. */
  trainsAt(at: Date): Train[] {
    const now = at.getHours() * 3600 + at.getMinutes() * 60 + at.getSeconds() + at.getMilliseconds() / 1000;
    const trains: Train[] = [];
    this.byTrain.clear();

    for (const pattern of this.patterns) {
      for (const departure of pattern.departures) {
        // 자정을 넘겨 달리는 열차는 전날 출발분이다.
        let elapsed = now - departure;
        if (elapsed < 0) elapsed += DAY_SEC;
        if (elapsed > pattern.totalSec) continue;

        const train = this.makeTrain(pattern, departure, elapsed);
        this.byTrain.set(train.id, { pattern, elapsed });
        trains.push(train);
      }
    }
    return trains;
  }

  private makeTrain(pattern: Pattern, departure: number, elapsed: number): Train {
    const { service, route, dir } = pattern;
    const progress = progressAt(pattern, elapsed);
    const forward = Math.min(route.length - END_MARGIN_M, Math.max(0, progress.along));
    const along = dir === 1 ? forward : route.length - forward;
    const pose = pointAlong(route.coords, route.dist, route.length, along);
    return {
      id: `${service.id}:${dir}:${departure}`,
      kind: "express",
      routeId: route.id,
      line: service.id,
      color: service.color,
      cars: service.cars,
      destination: pattern.names[pattern.names.length - 1],
      dir,
      along,
      dwell: progress.dwellLeft * 1000,
      lastStop: -1,
      speed: progress.speed,
      coord: pose.coord,
      heading: dir === 1 ? pose.heading : (pose.heading + 180) % 360,
    };
  }

  /** 계통 이름. 열차 패널 제목에 쓴다. */
  nameOf(train: Train): string {
    return this.byTrain.get(train.id)?.pattern.service.name ?? train.line;
  }

  /** 앞으로 설 역과 도착까지 남은 시간. trainsAt 으로 만든 열차만 답할 수 있다. */
  upcoming(train: Train, limit = 7): UpcomingStop[] {
    const entry = this.byTrain.get(train.id);
    if (!entry) return [];
    const { pattern, elapsed } = entry;
    const progress = progressAt(pattern, elapsed);
    const stops: UpcomingStop[] = [];
    for (let i = progress.stopIndex + 1; i < pattern.names.length && stops.length < limit; i++) {
      stops.push({
        name: pattern.names[i],
        distance: pattern.alongs[i] - progress.along,
        etaSec: Math.max(0, Math.round(pattern.arrive[i] - elapsed)),
      });
    }
    return stops;
  }
}

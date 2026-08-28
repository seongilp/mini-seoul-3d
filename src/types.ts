export type LineInfo = {
  id: string;
  name: string;
  nameEn: string;
  color: string;
  headway: number;
  cars: number;
};

export type RouteStation = {
  id: string;
  name: string;
  along: number;
  index: number;
};

export type Route = {
  id: string;
  line: string;
  loop: boolean;
  coords: [number, number][];
  length: number;
  stations: RouteStation[];
};

export type Station = {
  id: string;
  name: string;
  nameEn: string;
  lng: number;
  lat: number;
  lines: string[];
};

export type Network = {
  generatedAt: string;
  lines: LineInfo[];
  routes: Route[];
  stations: Station[];
};

export type SimState = {
  clockMs: number;
  speed: number;
  eco: boolean;
  underground: boolean;
  night: boolean;
  live: boolean;
  /** 승하차 인원 3D 기둥 레이어. */
  crowd: boolean;
  hiddenLines: Set<string>;
};

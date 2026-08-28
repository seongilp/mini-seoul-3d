import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { Ridership } from "../data/ridership";
import type { Station } from "../types";

const SOURCE_ID = "metro-crowd";
export const CROWD_LAYER = "metro-crowd-extrusion";

/** 기둥 밑면 반지름(m). 도심에서 역들이 붙어 있어도 겹치지 않을 정도. */
const RADIUS_M = 95;
/** 기둥 밑면 꼭짓점 수. 8각형이면 원처럼 보이면서 정점 수가 적다. */
const SIDES = 8;
/** 가장 붐비는 역·시간대의 기둥 높이(m). 건물(최고 약 300m)보다 확실히 높게. */
const MAX_HEIGHT_M = 900;
/** 이 인원 아래는 그리지 않는다. 새벽에 기둥이 바닥에 깔리는 걸 막는다. */
const MIN_PEOPLE = 40;

/** 순유입(-1~1) → 색. 주황은 사람이 빠지는 곳, 파랑은 모이는 곳. */
const COLOR_RAMP: Array<[number, string]> = [
  [-0.6, "#ff7a30"],
  [-0.2, "#e0a86a"],
  [0, "#b9ae9a"],
  [0.2, "#6fb6e8"],
  [0.6, "#2f8fe0"],
];

type Anchor = {
  id: string;
  /** 미리 계산한 8각형 좌표. 매 프레임 다시 만들지 않는다. */
  ring: [number, number][];
};

function makeRing(lng: number, lat: number): [number, number][] {
  // 위도에 따라 경도 1도의 실제 길이가 달라지므로 보정한다.
  const dLat = RADIUS_M / 111_320;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);

  const ring: [number, number][] = [];
  for (let i = 0; i < SIDES; i++) {
    const a = (i / SIDES) * Math.PI * 2;
    ring.push([lng + Math.cos(a) * dLng, lat + Math.sin(a) * dLat]);
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * 역별 승하차 인원을 3D 기둥으로 세우는 레이어.
 *
 * 높이는 그 시간대 승하차 합, 색은 승차·하차 균형을 나타낸다.
 * 시계가 흐르면 기둥이 자라고 줄면서 출퇴근 흐름이 드러난다.
 */
export class CrowdLayer {
  private readonly anchors: Anchor[] = [];
  private readonly ridership: Ridership;
  private added = false;

  constructor(ridership: Ridership, stations: Station[]) {
    this.ridership = ridership;
    for (const station of stations) {
      if (!ridership.has(station.id)) continue;
      this.anchors.push({ id: station.id, ring: makeRing(station.lng, station.lat) });
    }
  }

  get stationCount(): number {
    return this.anchors.length;
  }

  /** 스타일이 다시 로드되면 레이어도 사라지므로 그때마다 호출해야 한다. */
  attach(map: MapLibreMap, beforeId?: string): void {
    if (map.getLayer(CROWD_LAYER)) map.removeLayer(CROWD_LAYER);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);

    map.addSource(SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer(
      {
        id: CROWD_LAYER,
        type: "fill-extrusion",
        source: SOURCE_ID,
        paint: {
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["get", "net"],
            ...COLOR_RAMP.flat(),
          ],
          "fill-extrusion-opacity": 0.82,
        },
      },
      beforeId && map.getLayer(beforeId) ? beforeId : undefined,
    );
    this.added = true;
  }

  detach(map: MapLibreMap): void {
    if (map.getLayer(CROWD_LAYER)) map.removeLayer(CROWD_LAYER);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    this.added = false;
  }

  setVisible(map: MapLibreMap, visible: boolean): void {
    if (!map.getLayer(CROWD_LAYER)) return;
    map.setLayoutProperty(CROWD_LAYER, "visibility", visible ? "visible" : "none");
  }

  /** 소수 시각(8.5 = 8시 30분)에 맞춰 기둥을 다시 세운다. */
  update(map: MapLibreMap, hour: number): void {
    if (!this.added) return;
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    const features: GeoJSON.Feature[] = [];
    for (const anchor of this.anchors) {
      const sample = this.ridership.sampleAt(anchor.id, hour);
      if (!sample || sample.total < MIN_PEOPLE) continue;

      // 제곱근을 쓰면 작은 역도 보이고 큰 역이 과하게 솟지 않는다.
      const height = Math.sqrt(sample.total / this.ridership.peak) * MAX_HEIGHT_M;
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [anchor.ring] },
        properties: { height, net: sample.net },
      });
    }

    source.setData({ type: "FeatureCollection", features });
  }
}

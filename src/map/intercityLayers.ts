import type { Map as MapLibreMap } from "maplibre-gl";
import type { IntercityService } from "../intercity/service";

const ROUTE_SOURCE = "intercity-routes";
const STATION_SOURCE = "intercity-stations";
/** 열차 3D 레이어. 노선은 그 아래에 깔려야 열차를 가리지 않는다. */
const TRAIN_LAYER = "metro-trains-3d";
/** KTX 와 SRT 가 같은 선로를 달리는 구간에서 두 선이 나란히 보이게 벌리는 폭(px). */
const SRT_OFFSET_PX = 2.5;
/** 역 이름은 전국을 볼 때부터 보이고, 지하철 역 이름이 나오는 줌에서는 물러난다. */
const LABEL_MAX_ZOOM = 12.5;

/** 여러 계통이 서는 역은 한 번만 찍는다. */
function stationFeatures(services: IntercityService[]): GeoJSON.Feature[] {
  const seen = new Map<string, GeoJSON.Feature>();
  for (const service of services) {
    for (const stop of service.stops) {
      if (seen.has(stop.name)) continue;
      const coord = coordAt(service, stop.along);
      seen.set(stop.name, {
        type: "Feature",
        properties: { name: stop.name },
        geometry: { type: "Point", coordinates: coord },
      });
    }
  }
  return [...seen.values()];
}

/** 노선 위 along(m) 지점의 좌표. 역 점을 찍는 데만 써서 정밀할 필요는 없다. */
function coordAt(service: IntercityService, along: number): [number, number] {
  const index = Math.min(
    service.coords.length - 1,
    Math.max(0, Math.round((along / service.length) * (service.coords.length - 1))),
  );
  // 점 간격이 고르지 않아 비율로 찍으면 어긋난다. 가까운 점부터 거리를 재며 맞춘다.
  let best = service.coords[index];
  let bestGap = Infinity;
  let walked = 0;
  for (let i = 1; i < service.coords.length; i++) {
    const a = service.coords[i - 1];
    const b = service.coords[i];
    const step = Math.hypot((b[0] - a[0]) * 88800, (b[1] - a[1]) * 110540);
    if (walked + step >= along) {
      const t = step === 0 ? 0 : (along - walked) / step;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    walked += step;
    const gap = Math.abs(walked - along);
    if (gap < bestGap) {
      bestGap = gap;
      best = b;
    }
  }
  return best;
}

export function addIntercityLayers(map: MapLibreMap, services: IntercityService[], night: boolean): void {
  if (map.getSource(ROUTE_SOURCE)) return;
  const before = map.getLayer(TRAIN_LAYER) ? TRAIN_LAYER : undefined;

  map.addSource(ROUTE_SOURCE, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: services.map((s) => ({
        type: "Feature" as const,
        properties: { id: s.id, color: s.color, offset: s.operator === "SRT" ? SRT_OFFSET_PX : 0 },
        geometry: { type: "LineString" as const, coordinates: s.coords },
      })),
    },
  });
  map.addSource(STATION_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: stationFeatures(services) },
  });

  map.addLayer(
    {
      id: "intercity-line",
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.6, 10, 2.4, 14, 3.4, 16, 4.6],
        "line-offset": ["get", "offset"],
        "line-opacity": 0.9,
      },
    },
    before,
  );

  map.addLayer(
    {
      id: "intercity-station",
      type: "circle",
      source: STATION_SOURCE,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2.4, 10, 4, 15, 6],
        "circle-color": "#ffffff",
        "circle-stroke-color": "#1f2a44",
        "circle-stroke-width": 1.6,
      },
    },
    before,
  );

  map.addLayer({
    id: "intercity-station-label",
    type: "symbol",
    source: STATION_SOURCE,
    maxzoom: LABEL_MAX_ZOOM,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 6, 10.5, 10, 12.5],
      "text-offset": [0, 0.9],
      "text-anchor": "top",
      "text-padding": 2,
    },
    paint: {
      "text-color": night ? "#eef1f6" : "#1f2a44",
      "text-halo-color": night ? "#141820" : "#fbf7ee",
      "text-halo-width": 1.6,
    },
  });
}

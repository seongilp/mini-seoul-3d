import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

/**
 * 막차 보기 레이어. 켜면 원래 노선을 흐리게 깔고, 아직 막차가 지나지 않은
 * 구간만 밝게 그린다. 시각이 흐르면 막차가 지나간 구간부터 불이 꺼진다.
 */

const SOURCE = "last-run";
const GLOW = "last-run-glow";
const LINE = "last-run-line";
/** 역 점이 구간 선 위에 오도록 그 아래에 끼운다. */
const BEFORE = "metro-station-ring";

/** 막차 보기에서 원래 노선을 얼마나 흐리게 둘지. 꺼진 구간이 어디였는지는 보여야 한다. */
const GHOST_OPACITY = 0.16;
const LINE_OPACITY = 0.95;
const HALO_OPACITY = 0.22;

const lit = (minutes: number, on: number) => ["case", ["<=", ["get", "end"], minutes], 0, on];

function ensureLayers(map: MapLibreMap, data: GeoJSON.FeatureCollection): void {
  const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(SOURCE, { type: "geojson", data });
  const before = map.getLayer(BEFORE) ? BEFORE : undefined;
  map.addLayer(
    {
      id: GLOW,
      type: "line",
      source: SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 14, 14, 16, 20],
        "line-blur": 6,
        "line-opacity": 0,
      },
    },
    before,
  );
  map.addLayer(
    {
      id: LINE,
      type: "line",
      source: SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.2, 14, 4.6, 16, 6.4],
        "line-opacity": 0,
      },
    },
    before,
  );
}

function setBaseOpacity(map: MapLibreMap, dim: boolean): void {
  if (map.getLayer("metro-line")) {
    map.setPaintProperty("metro-line", "line-opacity", dim ? GHOST_OPACITY : LINE_OPACITY);
  }
  if (map.getLayer("metro-halo")) {
    map.setPaintProperty("metro-halo", "line-opacity", dim ? 0 : HALO_OPACITY);
  }
}

/**
 * 막차 보기를 켜고 끈다. 스타일을 다시 불러온 뒤에도 불러 줘야 한다.
 * data 는 켤 때만 필요하다.
 */
export function setLastRun(
  map: MapLibreMap,
  on: boolean,
  data: GeoJSON.FeatureCollection | null,
  minutes: number,
): void {
  setBaseOpacity(map, on);
  if (!on) {
    for (const id of [GLOW, LINE]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
    }
    return;
  }
  if (!data) return;
  ensureLayers(map, data);
  for (const id of [GLOW, LINE]) map.setLayoutProperty(id, "visibility", "visible");
  setLastRunTime(map, minutes);
}

/** 지금 시각(운행일 기준 분)에 맞춰 구간을 끄고 켠다. */
export function setLastRunTime(map: MapLibreMap, minutes: number): void {
  if (!map.getLayer(LINE)) return;
  map.setPaintProperty(LINE, "line-opacity", lit(minutes, 1));
  map.setPaintProperty(GLOW, "line-opacity", lit(minutes, 0.35));
}

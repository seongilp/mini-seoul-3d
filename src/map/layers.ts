import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { Network } from "../types";

const CHIP_IMAGE = "station-chip";
/** 칩 이미지는 2배로 그려 레티나에서도 모서리가 뭉개지지 않게 한다. */
const CHIP_RATIO = 2;
const CHIP_SIZE = 24;
const CHIP_RADIUS = 7;

/**
 * 역 이름표 단계. 환승 노선이 많은 역일수록 멀리서도 보인다.
 * 한 레이어에서 줌으로 거를 수 없어 단계마다 레이어를 둔다.
 */
const LABEL_TIERS: ReadonlyArray<{ id: string; minLines: number; maxLines: number; minzoom: number }> = [
  { id: "metro-station-label-hub", minLines: 3, maxLines: 99, minzoom: 10.6 },
  { id: "metro-station-label-transfer", minLines: 2, maxLines: 2, minzoom: 12.2 },
  { id: "metro-station-label", minLines: 1, maxLines: 1, minzoom: 13.4 },
];

const CHIP_THEME = {
  day: { fill: "#ffffff", stroke: "rgba(17,19,24,0.12)", text: "#15171c", sub: "#7a808a" },
  night: { fill: "#1d2027", stroke: "rgba(255,255,255,0.14)", text: "#f1f2f4", sub: "#8f96a1" },
} as const;

/** 둥근 사각형 칩. 가운데만 늘어나서 글자 길이에 맞춰도 모서리는 그대로다. */
function drawChip(fill: string, stroke: string): ImageData {
  const px = CHIP_SIZE * CHIP_RATIO;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  const r = CHIP_RADIUS * CHIP_RATIO;
  const inset = CHIP_RATIO;
  ctx.beginPath();
  ctx.roundRect(inset, inset, px - inset * 2, px - inset * 2, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = CHIP_RATIO;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  return ctx.getImageData(0, 0, px, px);
}

function ensureChipImage(map: MapLibreMap, night: boolean): void {
  const theme = night ? CHIP_THEME.night : CHIP_THEME.day;
  const data = drawChip(theme.fill, theme.stroke);
  if (map.hasImage(CHIP_IMAGE)) {
    map.updateImage(CHIP_IMAGE, data);
    return;
  }
  const edge = (CHIP_RADIUS + 1) * CHIP_RATIO;
  const far = CHIP_SIZE * CHIP_RATIO - edge;
  map.addImage(CHIP_IMAGE, data, {
    pixelRatio: CHIP_RATIO,
    stretchX: [[edge, far]],
    stretchY: [[edge, far]],
  });
}

function addStationLabels(map: MapLibreMap, night: boolean): void {
  const theme = night ? CHIP_THEME.night : CHIP_THEME.day;
  for (const tier of LABEL_TIERS) {
    map.addLayer({
      id: tier.id,
      type: "symbol",
      source: "metro-stations",
      minzoom: tier.minzoom,
      filter: [
        "all",
        [">=", ["get", "lineCount"], tier.minLines],
        ["<=", ["get", "lineCount"], tier.maxLines],
      ],
      layout: {
        "text-field": [
          "format",
          ["get", "name"],
          { "font-scale": 1, "text-font": ["literal", ["Noto Sans Bold"]] },
          "\n",
          {},
          ["upcase", ["get", "nameEn"]],
          { "font-scale": 0.68, "text-color": theme.sub },
        ],
        "text-font": ["Noto Sans Regular"],
        "text-size": tier.minLines >= 3 ? 12.5 : 11.5,
        "text-line-height": 1.15,
        "text-anchor": "bottom",
        "text-offset": [0, -0.9],
        "text-max-width": 12,
        "text-optional": false,
        "icon-image": CHIP_IMAGE,
        "icon-text-fit": "both",
        "icon-text-fit-padding": [4, 8, 3, 8],
        // 환승 노선이 많은 역이 겹칠 때 먼저 자리를 잡는다.
        "symbol-sort-key": ["-", 0, ["get", "lineCount"]],
      },
      paint: {
        "text-color": theme.text,
      },
    });
  }
}

export function addTransitLayers(
  map: MapLibreMap,
  network: Network,
  hidden: Set<string>,
  night = true,
): void {
  const routes = {
    type: "FeatureCollection" as const,
    features: network.routes
      .filter((r) => !hidden.has(r.line))
      .map((r) => ({
        type: "Feature" as const,
        properties: {
          id: r.id,
          line: r.line,
          color: network.lines.find((l) => l.id === r.line)?.color ?? "#888",
        },
        geometry: { type: "LineString" as const, coordinates: r.coords },
      })),
  };

  const stations = {
    type: "FeatureCollection" as const,
    features: network.stations
      .filter((s) => s.lines.some((line) => !hidden.has(line)))
      .map((s) => ({
        type: "Feature" as const,
        properties: {
          id: s.id,
          name: s.name,
          nameEn: s.nameEn,
          lines: s.lines.join(","),
          lineCount: s.lines.length,
        },
        geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
      })),
  };

  if (!map.getSource("metro-routes")) {
    map.addSource("metro-routes", { type: "geojson", data: routes });
    map.addSource("metro-stations", { type: "geojson", data: stations });

    map.addLayer({
      id: "metro-halo",
      type: "line",
      source: "metro-routes",
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.2, 14, 7, 16, 11],
        "line-opacity": 0.22,
        "line-blur": 2.4,
      },
    });

    map.addLayer({
      id: "metro-line",
      type: "line",
      source: "metro-routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.6, 14, 3.6, 16, 5.2],
        "line-opacity": 0.95,
      },
    });

    map.addLayer({
      id: "metro-station-ring",
      type: "circle",
      source: "metro-stations",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.2, 15, 5.4],
        "circle-color": "#111111",
        "circle-stroke-color": "#f6f0e4",
        "circle-stroke-width": 1.4,
        "circle-opacity": 0.92,
      },
    });

    ensureChipImage(map, night);
    addStationLabels(map, night);
    return;
  }

  (map.getSource("metro-routes") as GeoJSONSource).setData(routes);
  (map.getSource("metro-stations") as GeoJSONSource).setData(stations);

  // 스타일을 바꿔도 소스가 남아 있으면 이 길로 온다. 이름표 색을 새 테마로 다시 칠한다.
  ensureChipImage(map, night);
  for (const tier of LABEL_TIERS) {
    if (map.getLayer(tier.id)) map.removeLayer(tier.id);
  }
  addStationLabels(map, night);
}

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const SEOUL: [number, number] = [126.9784, 37.5665];

export const STYLES = {
  day: "https://tiles.openfreemap.org/styles/liberty",
  night: "https://tiles.openfreemap.org/styles/dark",
} as const;

export function createMap(container: HTMLElement, night: boolean): maplibregl.Map {
  return new maplibregl.Map({
    container,
    style: night ? STYLES.night : STYLES.day,
    center: SEOUL,
    zoom: 12.45,
    pitch: 60,
    bearing: -22,
    maxPitch: 72,
    minZoom: 9.2,
    maxZoom: 17.4,
    attributionControl: false,
    hash: false,
    canvasContextAttributes: { antialias: true },
  });
}

export function restyleBase(map: maplibregl.Map, night: boolean): void {
  const style = map.getStyle();
  if (!style?.layers) return;

  for (const layer of style.layers) {
    const id = layer.id;
    try {
      if (layer.type === "background") {
        map.setPaintProperty(id, "background-color", night ? "#141820" : "#e6e0d2");
      }
      if (layer.type === "fill" && /water|ocean|river/.test(id)) {
        map.setPaintProperty(id, "fill-color", night ? "#1d3a48" : "#8fb8bf");
      }
      if (layer.type === "fill" && /park|landcover|landuse|wood|grass/.test(id)) {
        map.setPaintProperty(id, "fill-color", night ? "#1c2a22" : "#c4d2b0");
      }
      if (layer.type === "fill" && /building/.test(id) && !/3d/.test(id)) {
        map.setPaintProperty(id, "fill-color", night ? "#2a3038" : "#d8d2c6");
        map.setPaintProperty(id, "fill-opacity", 0.35);
      }
      if (layer.type === "line" && /road|street|bridge|tunnel/.test(id)) {
        if (map.getPaintProperty(id, "line-color")) {
          map.setPaintProperty(id, "line-color", night ? "#3a4250" : "#cfc6b6");
        }
        if (map.getPaintProperty(id, "line-opacity") !== undefined) {
          map.setPaintProperty(id, "line-opacity", night ? 0.35 : 0.55);
        }
      }
      if (
        (layer.type === "symbol" || layer.type === "circle") &&
        /poi|shop|label|shield|highway_name|road_number/.test(id)
      ) {
        map.setLayoutProperty(id, "visibility", "none");
      }
    } catch {
      // some paint props are not set on every layer
    }
  }

  ensureBuildings(map, night);
}

function ensureBuildings(map: maplibregl.Map, night: boolean): void {
  if (map.getLayer("seoul-buildings")) return;
  const source = map.getSource("openmaptiles") ? "openmaptiles" : null;
  if (!source) return;
  map.addLayer({
    id: "seoul-buildings",
    source,
    "source-layer": "building",
    type: "fill-extrusion",
    minzoom: 13.4,
    paint: {
      "fill-extrusion-color": night ? "#3a4452" : "#d5cfc3",
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 12],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
      "fill-extrusion-opacity": 0.72,
    },
  });
}

export function setUnderground(map: maplibregl.Map, on: boolean, night = false): void {
  if (map.getLayer("seoul-buildings")) {
    map.setPaintProperty("seoul-buildings", "fill-extrusion-opacity", on ? 0.08 : 0.72);
  }
  const bg = map.getStyle().layers?.find((l) => l.type === "background");
  if (bg) {
    const surface = night ? "#141820" : "#e6e0d2";
    map.setPaintProperty(bg.id, "background-color", on ? "#0b0f14" : surface);
  }
}

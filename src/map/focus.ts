import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { Station } from "../types";

const SOURCE_ID = "metro-focus";
const RING_LAYER = "metro-focus-ring";
const CORE_LAYER = "metro-focus-core";

/** 파문 한 번이 도는 데 걸리는 시간(ms). */
const PULSE_MS = 1800;
/** 파문의 최소·최대 반지름(px). */
const RING_MIN_PX = 10;
const RING_MAX_PX = 34;

/**
 * 선택한 역을 표시하는 파문.
 *
 * 카메라가 내려앉는 동안 어디를 보는지 알려 준다. 반지름과 투명도만 매 프레임
 * 바꾸므로 GeoJSON 은 역이 바뀔 때만 다시 만든다.
 */
export class StationFocus {
  private stationId: string | null = null;
  private startedAt = 0;

  attach(map: MapLibreMap): void {
    for (const id of [RING_LAYER, CORE_LAYER]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);

    map.addSource(SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: RING_LAYER,
      type: "circle",
      source: SOURCE_ID,
      paint: {
        "circle-radius": RING_MIN_PX,
        "circle-color": "transparent",
        "circle-stroke-color": "#ff6b4a",
        "circle-stroke-width": 2,
        "circle-stroke-opacity": 0.9,
      },
    });

    map.addLayer({
      id: CORE_LAYER,
      type: "circle",
      source: SOURCE_ID,
      paint: {
        "circle-radius": 5.5,
        "circle-color": "#ff6b4a",
        "circle-stroke-color": "#fdf3e6",
        "circle-stroke-width": 2,
      },
    });

    // 레이어를 다시 붙였으니 보고 있던 역이 있으면 되살린다.
    if (this.stationId) this.redraw(map);
  }

  private data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

  set(map: MapLibreMap, station: Station, now: number): void {
    this.stationId = station.id;
    this.startedAt = now;
    this.data = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [station.lng, station.lat] },
          properties: {},
        },
      ],
    };
    this.redraw(map);
  }

  clear(map: MapLibreMap): void {
    this.stationId = null;
    this.data = { type: "FeatureCollection", features: [] };
    this.redraw(map);
  }

  private redraw(map: MapLibreMap): void {
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(this.data);
  }

  /** 파문을 한 칸 굴린다. 표시 중인 역이 없으면 아무 일도 하지 않는다. */
  tick(map: MapLibreMap, now: number): void {
    if (!this.stationId || !map.getLayer(RING_LAYER)) return;

    const t = ((now - this.startedAt) % PULSE_MS) / PULSE_MS;
    const radius = RING_MIN_PX + (RING_MAX_PX - RING_MIN_PX) * t;
    map.setPaintProperty(RING_LAYER, "circle-radius", radius);
    // 퍼지면서 옅어져 물결처럼 보인다.
    map.setPaintProperty(RING_LAYER, "circle-stroke-opacity", 0.85 * (1 - t) ** 1.3);
  }
}

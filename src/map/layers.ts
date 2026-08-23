import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { Network } from "../types";

export function addTransitLayers(map: MapLibreMap, network: Network, hidden: Set<string>): void {
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

    map.addLayer({
      id: "metro-station-label",
      type: "symbol",
      source: "metro-stations",
      minzoom: 13.2,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-offset": [0, 1.05],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: {
        "text-color": "#241c14",
        "text-halo-color": "#f3ecde",
        "text-halo-width": 1.2,
      },
    });
    return;
  }

  (map.getSource("metro-routes") as GeoJSONSource).setData(routes);
  (map.getSource("metro-stations") as GeoJSONSource).setData(stations);
}

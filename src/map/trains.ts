import maplibregl from "maplibre-gl";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import * as THREE from "three";
import type { Train } from "../sim/fleet";

const ORIGIN: [number, number] = [126.9784, 37.5665];
const BOX_LEN = 10;
const MAX = 512;
const LAYER_ID = "metro-trains-3d";
const LABEL_SOURCE = "metro-train-labels";
const LABEL_LAYER = "metro-train-label";
/** 이 줌 아래에서는 라벨이 서로 겹쳐 읽기 어렵다. */
const LABEL_MIN_ZOOM = 12.8;
/**
 * 라벨 갱신 주기(ms). setData 는 GeoJSON 을 워커로 넘겨 다시 파싱하므로
 * 매 프레임 호출하면 열차 수백 대에서 프레임이 무너진다.
 */
const LABEL_INTERVAL_MS = 400;

function trainScale(zoom: number): number {
  const metersPerPx = (156543.03392 * Math.cos((37.5665 * Math.PI) / 180)) / 2 ** zoom;
  const targetPx = zoom < 12.6 ? 10 : zoom < 14 ? 13 : zoom < 15.6 ? 16 : 20;
  return Math.max(1.6, (targetPx * metersPerPx) / BOX_LEN);
}

/**
 * MapLibre 커스텀 3D 레이어. 맵의 GL 컨텍스트와 투영 행렬을 그대로 사용해서
 * 열차 박스를 노선 위에 정확히 올린다.
 */
class TrainLayer implements CustomLayerInterface {
  readonly id = LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private camera = new THREE.Camera();
  private scene = new THREE.Scene();
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private trains: Train[] = [];
  private originMerc = maplibregl.MercatorCoordinate.fromLngLat(ORIGIN, 0);
  private boxes: THREE.InstancedMesh;
  private rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  private local = new THREE.Matrix4();
  private proj = new THREE.Matrix4();
  private scaleV = new THREE.Vector3();
  private bufW = 0;
  private bufH = 0;

  constructor() {
    const geo = new THREE.BoxGeometry(BOX_LEN, 3.2, 3.2);
    geo.translate(0, 1.6, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    mat.toneMapped = false;
    this.boxes = new THREE.InstancedMesh(geo, mat, MAX);
    this.boxes.frustumCulled = false;
    this.boxes.count = 0;
    this.scene.add(this.boxes);
  }

  setTrains(trains: Train[]): void {
    this.trains = trains;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    this.renderer.autoClear = false;
  }

  onRemove(): void {
    this.scene.clear();
    this.boxes.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  render(_gl: unknown, args: CustomRenderMethodInput): void {
    const map = this.map;
    const renderer = this.renderer;
    if (!map || !renderer) return;

    this.syncViewport(renderer, map.getCanvas());
    this.sync(map.getZoom());
    if (this.boxes.count === 0) return;

    const t = this.originMerc;
    const meter = t.meterInMercatorCoordinateUnits();
    this.scaleV.set(meter, -meter, meter);
    this.local
      .identity()
      .makeTranslation(t.x, t.y, t.z)
      .scale(this.scaleV)
      .multiply(this.rotX);

    this.camera.projectionMatrix = this.proj
      .fromArray(args.defaultProjectionData.mainMatrix)
      .multiply(this.local);

    renderer.resetState();
    renderer.render(this.scene, this.camera);
    map.triggerRepaint();
  }

  /**
   * three는 생성 시점의 캔버스 크기로 뷰포트를 고정한다. 창 크기나 devicePixelRatio가
   * 바뀌면 GL 뷰포트가 옛 값에 묶여 화면 일부만 그려지므로 매 프레임 맞춰 준다.
   */
  private syncViewport(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement): void {
    if (canvas.width === this.bufW && canvas.height === this.bufH) return;
    this.bufW = canvas.width;
    this.bufH = canvas.height;
    renderer.setPixelRatio(1);
    renderer.setViewport(0, 0, this.bufW, this.bufH);
  }

  private sync(zoom: number): void {
    const origin = this.originMerc;
    const meter = origin.meterInMercatorCoordinateUnits();
    const s = trainScale(zoom);
    let n = 0;

    for (const train of this.trains) {
      if (n >= MAX) break;
      const p = maplibregl.MercatorCoordinate.fromLngLat(train.coord, 0);
      this.dummy.position.set((p.x - origin.x) / meter, 2.4, (p.y - origin.y) / meter);
      this.dummy.rotation.set(0, ((90 - train.heading) * Math.PI) / 180, 0);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.boxes.setMatrixAt(n, this.dummy.matrix);
      this.color.set(train.color);
      this.boxes.setColorAt(n, this.color);
      n++;
    }

    this.boxes.count = n;
    this.boxes.instanceMatrix.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
  }
}

let layer: TrainLayer | null = null;

/** 열차 행선지를 GeoJSON 으로 만든다. 라벨이 보이는 줌에서만 호출한다. */
function labelData(trains: Train[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: trains
      .filter((t) => t.destination)
      .map((t) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: t.coord },
        properties: { label: `${t.destination}행`, color: t.color },
      })),
  };
}

function addLabelLayer(map: MapLibreMap): void {
  if (map.getLayer(LABEL_LAYER)) map.removeLayer(LABEL_LAYER);
  if (map.getSource(LABEL_SOURCE)) map.removeSource(LABEL_SOURCE);

  map.addSource(LABEL_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: LABEL_LAYER,
    type: "symbol",
    source: LABEL_SOURCE,
    minzoom: LABEL_MIN_ZOOM,
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 12.5],
      // 열차 박스 위쪽에 띄운다.
      "text-offset": [0, -1.5],
      "text-anchor": "bottom",
      // 겹치면 MapLibre 가 알아서 일부만 남긴다.
      "text-optional": true,
      "text-padding": 3,
    },
    paint: {
      "text-color": ["get", "color"],
      "text-halo-color": "#fbf7ee",
      "text-halo-width": 1.6,
    },
  });
}

export function addTrainLayers(map: MapLibreMap, trains: Train[]): void {
  for (const id of [LAYER_ID, "metro-train-dot", "metro-train-glow", "metro-train-body"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource("metro-trains")) map.removeSource("metro-trains");

  document.querySelector("#train-overlay")?.remove();

  layer = new TrainLayer();
  layer.setTrains(trains);
  map.addLayer(layer);
  addLabelLayer(map);
}

let lastLabelAt = 0;
let labelsCleared = true;

export function updateTrains(map: MapLibreMap, trains: Train[]): void {
  if (!layer || !map.getLayer(LAYER_ID)) return;
  layer.setTrains(trains);
  syncLabels(map, trains);
  map.triggerRepaint();
}

function syncLabels(map: MapLibreMap, trains: Train[]): void {
  const source = map.getSource(LABEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;

  if (map.getZoom() < LABEL_MIN_ZOOM) {
    if (!labelsCleared) {
      source.setData({ type: "FeatureCollection", features: [] });
      labelsCleared = true;
    }
    return;
  }

  const now = performance.now();
  if (now - lastLabelAt < LABEL_INTERVAL_MS) return;
  lastLabelAt = now;
  labelsCleared = false;
  source.setData(labelData(trains));
}

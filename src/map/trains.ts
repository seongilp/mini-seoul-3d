import maplibregl from "maplibre-gl";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { pointAlong } from "../geo";
import { congestionColor } from "../sim/congestion";
import { headsign, type PreparedRoute, type Train } from "../sim/fleet";

const ORIGIN: [number, number] = [126.9784, 37.5665];
/** 실제 전동차 1량 길이(m). */
const CAR_LENGTH_M = 20;
/**
 * 차체 폭·높이를 한 칸 길이에 대한 비율로.
 * 실제 비율(20m × 3.2m)대로 그리면 위에서 볼 때 실처럼 보여 열차로 읽히지
 * 않는다. 지도용으로 통통하게 잡는다.
 */
const CAR_WIDTH = 0.42;
const CAR_HEIGHT = 0.32;
/** 칸 사이를 살짝 띄워 편성이 마디로 보이게 한다. 둥근 끝이 연결부처럼 보인다. */
const CAR_FILL = 0.93;
/** 차체 모서리 둥글기(단위 상자 기준). 길이 방향으로는 끝이 둥글게 말린다. */
const BODY_RADIUS = 0.14;
/** 창문 띠. 옆면 위쪽에 어두운 유리를 두른다. 폭을 조금 넘겨 옆으로 비어져 나오게 한다. */
const WINDOW_COLOR = 0x1b2330;
/** 운전실 앞유리. 창문보다 조금 더 어둡다. */
const CAB_COLOR = 0x10151d;
/** 지붕판은 노선 색에 흰색을 이만큼 섞는다. 위에서 볼 때 윗면이 밝게 떠야 입체로 읽힌다. */
const ROOF_TINT = 0.45;

/** 칸 단위 공간(길이 x, 높이 y 0~1, 폭 z)에서 부품 자리. */
const localBox = (x: number, y: number, sx: number, sy: number, sz: number) =>
  new THREE.Matrix4().makeTranslation(x, y, 0).multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
/** 옆면 위쪽 창문 띠. 끝은 둥근 부분에 걸리지 않게 짧게. */
const WINDOW_LOCAL = localBox(0, 0.5, 0.78, 0.26, 1.015);
/** 지붕판. 둥근 모서리 안쪽에 얹어 윗면만 밝힌다. */
const ROOF_LOCAL = localBox(0, 0.985, 0.74, 0.05, 0.62);
/** 운전실 앞유리. 칸 끝면에서 살짝 튀어나온다. */
const CAB_FRONT = localBox(0.492, 0.46, 0.03, 0.34, 0.72);
const CAB_BACK = localBox(-0.492, 0.46, 0.03, 0.34, 0.72);
/** 전조등·미등. 앞유리 아래에 가로로 길게. 진행 방향이 한눈에 보인다. */
const LAMP_FRONT = localBox(0.497, 0.2, 0.02, 0.09, 0.6);
const LAMP_BACK = localBox(-0.497, 0.2, 0.02, 0.09, 0.6);
const HEADLIGHT_COLOR = 0xfff4d6;
const TAILLIGHT_COLOR = 0xff3b30;
/** 아무리 멀어져도 편성 전체가 이 픽셀 길이보다 짧아 보이지 않게 한다. */
const MIN_TRAIN_PX = 15;
/** 차체 폭도 같은 이유로 하한을 둔다. 없으면 멀리서 실처럼 얇아진다. */
const MIN_WIDTH_PX = 5;
/** 이 줌부터 칸을 나눠 그린다. 그 아래는 한 덩어리라 어차피 구분되지 않는다. */
const CONSIST_ZOOM = 13.2;
/** 한 편성의 최대 칸 수. */
const MAX_CARS = 10;
/** 인스턴스 상한. 열차 400대 × 10칸을 담고도 남는다. */
const MAX_INSTANCES = 4600;
/** 혼잡도를 어림할 자료가 없는 열차. 사람 보기 모드에서만 쓴다. */
const UNKNOWN_CONGESTION_COLOR = "#6b6862";
const LAYER_ID = "metro-trains-3d";
const LABEL_SOURCE = "metro-train-labels";
const LABEL_LAYER = "metro-train-label";
export const TRAIN_HIT_LAYER = "metro-train-hit";
/** 이 줌 아래에서는 라벨이 서로 겹쳐 읽기 어렵다. */
const LABEL_MIN_ZOOM = 12.8;
/**
 * 라벨 갱신 주기(ms). setData 는 GeoJSON 을 워커로 넘겨 다시 파싱하므로
 * 매 프레임 호출하면 열차 수백 대에서 프레임이 무너진다.
 */
const LABEL_INTERVAL_MS = 400;

/** 그 줌에서 화면 1픽셀이 몇 미터인지. */
function metersPerPixel(zoom: number): number {
  return (156543.03392 * Math.cos((37.5665 * Math.PI) / 180)) / 2 ** zoom;
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
  private routes = new Map<string, PreparedRoute>();
  private originMerc = maplibregl.MercatorCoordinate.fromLngLat(ORIGIN, 0);
  private boxes: THREE.InstancedMesh;
  /** 창문 띠·지붕판·앞유리. 가까이서만 그린다. */
  private windows: THREE.InstancedMesh;
  private roofs: THREE.InstancedMesh;
  private cabs: THREE.InstancedMesh;
  /** 등은 조명을 받지 않는 재질이라 밤에도 빛나 보인다. */
  private headlights: THREE.InstancedMesh;
  private taillights: THREE.InstancedMesh;
  private white = new THREE.Color(0xffffff);
  private roofTint = new THREE.Color();
  private part = new THREE.Matrix4();
  private rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  private local = new THREE.Matrix4();
  private proj = new THREE.Matrix4();
  private scaleV = new THREE.Vector3();
  private bufW = 0;
  private bufH = 0;

  constructor() {
    // 단위 크기로 두고 칸마다 길이·폭·높이를 따로 준다. 바닥이 y=0 에 오게 올린다.
    const body = new RoundedBoxGeometry(1, 1, 1, 2, BODY_RADIUS);
    body.translate(0, 0.5, 0);
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);

    // 조명을 받는 재질이라야 차체 윗면과 옆면의 밝기가 갈려 입체로 보인다.
    // MeshBasicMaterial 은 음영이 없어 위에서 보면 납작한 색 조각처럼 읽힌다.
    const lit = (color: number) => {
      const mat = new THREE.MeshLambertMaterial({ color });
      mat.toneMapped = false;
      return mat;
    };
    const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, count: number) => {
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
      return mesh;
    };
    this.boxes = instanced(body, lit(0xffffff), MAX_INSTANCES);
    this.roofs = instanced(box, lit(0xffffff), MAX_INSTANCES);
    this.windows = instanced(box, lit(WINDOW_COLOR), MAX_INSTANCES);
    // 편성마다 앞뒤 두 개.
    this.cabs = instanced(box, lit(CAB_COLOR), MAX_INSTANCES);
    const glow = (color: number) => {
      const mat = new THREE.MeshBasicMaterial({ color });
      mat.toneMapped = false;
      return mat;
    };
    this.headlights = instanced(box, glow(HEADLIGHT_COLOR), MAX_INSTANCES);
    this.taillights = instanced(box, glow(TAILLIGHT_COLOR), MAX_INSTANCES);

    // 위에서 살짝 비스듬히 비춰 윗면이 가장 밝고 옆면이 어둡게 한다.
    // 주변광을 높게 두어 노선 색이 어두워지지 않게 하고, 방향광은 면을
    // 구분할 만큼만 준다.
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.position.set(-0.45, 1, -0.35);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.92));
  }

  setTrains(trains: Train[]): void {
    this.trains = trains;
  }

  /** 칸을 선로 곡선 위에 올리려면 노선 형상이 필요하다. */
  setRoutes(routes: PreparedRoute[]): void {
    this.routes = new Map(routes.map((r) => [r.id, r]));
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
    this.windows.dispose();
    this.roofs.dispose();
    this.cabs.dispose();
    this.headlights.dispose();
    this.taillights.dispose();
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
    const perPixel = metersPerPixel(zoom);
    // 가까이서는 칸을 나눠 그리고, 멀어지면 한 덩어리로 둔다.
    const detailed = zoom >= CONSIST_ZOOM;
    let n = 0;
    let nCab = 0;
    let nLamp = 0;

    for (const train of this.trains) {
      if (n >= MAX_INSTANCES) break;

      const cars = Math.max(1, Math.min(MAX_CARS, Math.round(train.cars) || 1));
      // 실제 편성 길이를 쓰되, 멀리서도 점처럼 사라지지 않게 하한을 둔다.
      const totalLength = Math.max(CAR_LENGTH_M * cars, MIN_TRAIN_PX * perPixel);
      const segments = detailed ? cars : 1;
      const segLength = totalLength / segments;
      // 폭은 칸 수와 무관하게 한 칸 길이를 기준으로 잡아야 편성이 길어져도
      // 굵어지지 않는다.
      const carLength = totalLength / cars;
      const width = Math.max(carLength * CAR_WIDTH, MIN_WIDTH_PX * perPixel);
      const height = width * (CAR_HEIGHT / CAR_WIDTH);

      // 혼잡도 값은 늘 들어 있지만, 색으로 쓸지는 화면 모드가 정한다.
      // 자료가 없어 값을 못 낸 열차를 노선 색으로 두면 혼잡도 색과 섞여
      // 읽히므로 회색으로 빼 둔다.
      this.color.set(
        !colorByCongestion
          ? train.color
          : train.congestion === undefined
            ? UNKNOWN_CONGESTION_COLOR
            : congestionColor(train.congestion),
      );
      const route = this.routes.get(train.routeId);

      for (let c = 0; c < segments && n < MAX_INSTANCES; c++) {
        // 편성 한가운데가 train.along 에 오도록 앞뒤로 벌린다.
        const offset = ((segments - 1) / 2 - c) * segLength;

        let coord = train.coord;
        let heading = train.heading;
        if (route && offset !== 0) {
          const pose = pointAlong(
            route.coords,
            route.dist,
            route.length,
            train.along + offset * train.dir,
          );
          coord = pose.coord;
          heading = train.dir === -1 ? (pose.heading + 180) % 360 : pose.heading;
        }

        const p = maplibregl.MercatorCoordinate.fromLngLat(coord, 0);
        this.dummy.position.set((p.x - origin.x) / meter, 0.8, (p.y - origin.y) / meter);
        this.dummy.rotation.set(0, ((90 - heading) * Math.PI) / 180, 0);
        this.dummy.scale.set(segLength * CAR_FILL, height, width);
        this.dummy.updateMatrix();
        const car = this.dummy.matrix;
        this.boxes.setMatrixAt(n, car);
        this.boxes.setColorAt(n, this.color);

        if (detailed) {
          // 부품은 칸의 단위 공간에서 자리를 잡고 칸 변환을 그대로 따른다.
          this.windows.setMatrixAt(n, this.part.multiplyMatrices(car, WINDOW_LOCAL));
          this.roofs.setMatrixAt(n, this.part.multiplyMatrices(car, ROOF_LOCAL));
          this.roofTint.copy(this.color).lerp(this.white, ROOF_TINT);
          this.roofs.setColorAt(n, this.roofTint);
          // 맨 앞 칸은 앞쪽(+x), 맨 뒤 칸은 뒤쪽(-x)에 운전실이 있다.
          // 맨 앞 칸이 진행 방향이라 전조등, 맨 뒤 칸은 미등을 켠다.
          if (c === 0) {
            this.cabs.setMatrixAt(nCab++, this.part.multiplyMatrices(car, CAB_FRONT));
            this.headlights.setMatrixAt(nLamp, this.part.multiplyMatrices(car, LAMP_FRONT));
          }
          if (c === segments - 1) {
            this.cabs.setMatrixAt(nCab++, this.part.multiplyMatrices(car, CAB_BACK));
            this.taillights.setMatrixAt(nLamp, this.part.multiplyMatrices(car, LAMP_BACK));
            nLamp++;
          }
        }
        n++;
      }
    }

    this.boxes.count = n;
    this.windows.count = detailed ? n : 0;
    this.roofs.count = detailed ? n : 0;
    this.cabs.count = nCab;
    this.headlights.count = nLamp;
    this.taillights.count = nLamp;
    for (const mesh of [
      this.boxes,
      this.windows,
      this.roofs,
      this.cabs,
      this.headlights,
      this.taillights,
    ]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

}

let layer: TrainLayer | null = null;

/** 열차 행선지를 GeoJSON 으로 만든다. 라벨이 보이는 줌에서만 호출한다. */
function labelData(trains: Train[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: trains.map((t) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: t.coord },
      properties: {
        id: t.id,
        label: headsign(t.destination),
        color: t.color,
      },
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

  // 열차를 클릭할 수 있게 하는 투명 원. 3D 박스는 커스텀 레이어라 직접 집을 수 없다.
  map.addLayer({
    id: TRAIN_HIT_LAYER,
    type: "circle",
    source: LABEL_SOURCE,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 6, 16, 14],
      "circle-color": "#000000",
      "circle-opacity": 0,
    },
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

export function addTrainLayers(
  map: MapLibreMap,
  trains: Train[],
  routes: PreparedRoute[],
): void {
  for (const id of [LAYER_ID, TRAIN_HIT_LAYER, "metro-train-dot", "metro-train-glow", "metro-train-body"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource("metro-trains")) map.removeSource("metro-trains");

  document.querySelector("#train-overlay")?.remove();

  layer = new TrainLayer();
  layer.setRoutes(routes);
  layer.setTrains(trains);
  map.addLayer(layer);
  addLabelLayer(map);
}

/** 열차를 노선 색 대신 혼잡도 색으로 칠할지. */
let colorByCongestion = false;

export function setTrainColorMode(map: MapLibreMap, byCongestion: boolean): void {
  colorByCongestion = byCongestion;
  map.triggerRepaint();
}

let lastLabelAt = 0;

export function updateTrains(map: MapLibreMap, trains: Train[]): void {
  if (!layer || !map.getLayer(LAYER_ID)) return;
  layer.setTrains(trains);
  syncLabels(map, trains);
  map.triggerRepaint();
}

function syncLabels(map: MapLibreMap, trains: Train[]): void {
  const source = map.getSource(LABEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;

  // 줌이 낮아도 소스는 채워 둔다. 글자만 감출 뿐 클릭 판정은 살아 있어야 한다.
  const now = performance.now();
  if (now - lastLabelAt < LABEL_INTERVAL_MS) return;
  lastLabelAt = now;
  source.setData(labelData(trains));
}

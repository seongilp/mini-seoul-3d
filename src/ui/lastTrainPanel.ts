import type { LineLast } from "../data/lastTrain";
import type { Network } from "../types";

/**
 * 막차 보기 패널. 노선마다 막차 시각과 남은 시간을 보여 준다.
 * 역 패널과 같은 자리를 쓰며, 역을 고르면 CSS 가 이 패널을 잠시 감춘다.
 */

type SortKey = "line" | "early" | "late";

const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "line", label: "노선순" },
  { key: "early", label: "빨리 끝나는 순" },
  { key: "late", label: "늦게까지 순" },
];

/** 남은 시간 막대가 가득 차는 기준(분). 세 시간 넘게 남으면 가득 찬다. */
const BAR_FULL_MINUTES = 180;

/** 운행일 기준 분 → "00:48". */
function clock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function remainText(remain: number): string {
  if (remain <= 0) return "운행 종료";
  if (remain < 60) return `${remain}분 남음`;
  const h = Math.floor(remain / 60);
  const m = remain % 60;
  return m ? `${h}시간 ${m}분 남음` : `${h}시간 남음`;
}

/** 노선 배지 글자. "2호선" 은 2, 나머지는 노선 기호를 쓴다. */
function badgeText(id: string, name: string): string {
  const m = /^(\d+)호선$/.exec(name);
  return m ? m[1] : id;
}

export type LastTrainPanel = {
  setOpen: (open: boolean) => void;
  /** rows 는 노선별 막차, now 는 운행일 기준 지금 시각(분). */
  update: (rows: LineLast[], now: number, dayLabel: string) => void;
};

export function mountLastTrainPanel(
  host: HTMLElement,
  network: Network,
  onClose: () => void,
): LastTrainPanel {
  const root = document.createElement("section");
  root.className = "lastrun";
  root.hidden = true;
  root.setAttribute("aria-label", "막차");
  root.innerHTML = `
    <header class="lastrun-head">
      <div>
        <strong>막차</strong>
        <span class="lastrun-day"></span>
      </div>
      <button type="button" class="lastrun-close" aria-label="막차 보기 닫기">✕</button>
    </header>
    <div class="lastrun-sort" role="group" aria-label="정렬">
      ${SORTS.map((s) => `<button type="button" data-sort="${s.key}">${s.label}</button>`).join("")}
    </div>
    <div class="lastrun-summary"></div>
    <div class="lastrun-list"></div>
    <div class="lastrun-foot">시간 막대를 끌면 막차가 지나간 구간부터 불이 꺼집니다</div>
  `;
  host.appendChild(root);

  const day = root.querySelector(".lastrun-day") as HTMLElement;
  const summary = root.querySelector(".lastrun-summary") as HTMLElement;
  const list = root.querySelector(".lastrun-list") as HTMLElement;
  const sortButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-sort]")];
  const meta = new Map(network.lines.map((l, i) => [l.id, { ...l, order: i }]));

  let sort: SortKey = "line";
  let last: { rows: LineLast[]; now: number; dayLabel: string } | null = null;

  const paintSort = () => {
    for (const b of sortButtons) b.setAttribute("aria-pressed", String(b.dataset.sort === sort));
  };
  paintSort();
  for (const b of sortButtons) {
    b.addEventListener("click", () => {
      sort = b.dataset.sort as SortKey;
      paintSort();
      if (last) render(last.rows, last.now, last.dayLabel);
    });
  }
  root.querySelector(".lastrun-close")!.addEventListener("click", onClose);

  const row = (item: LineLast, now: number): HTMLElement => {
    const info = meta.get(item.line);
    const el = document.createElement("div");
    el.className = "lr-row";

    const badge = document.createElement("span");
    badge.className = "lr-badge";
    badge.style.setProperty("--c", info?.color ?? "#888");
    badge.textContent = badgeText(item.line, info?.name ?? item.line);

    const name = document.createElement("span");
    name.className = "lr-name";
    name.textContent = info?.name ?? item.line;

    const time = document.createElement("span");
    time.className = "lr-time";
    const t = document.createElement("b");
    const r = document.createElement("small");
    time.append(t, r);

    const bar = document.createElement("i");
    bar.className = "lr-bar";
    const fill = document.createElement("i");
    fill.style.background = info?.color ?? "#888";
    bar.appendChild(fill);

    if (item.last === null) {
      el.classList.add("is-unknown");
      t.textContent = "–";
      r.textContent = "시간표 없음";
    } else {
      const remain = item.last - now;
      t.textContent = clock(item.last);
      r.textContent = remainText(remain);
      if (remain <= 0) el.classList.add("is-done");
      else if (remain <= 30) el.classList.add("is-soon");
      fill.style.width = `${Math.max(0, Math.min(1, remain / BAR_FULL_MINUTES)) * 100}%`;
    }

    el.append(badge, name, time, bar);
    return el;
  };

  const ordered = (rows: LineLast[]): LineLast[] => {
    const known = rows.filter((r) => r.last !== null);
    const unknown = rows.filter((r) => r.last === null);
    const byLine = (a: LineLast, b: LineLast) =>
      (meta.get(a.line)?.order ?? 0) - (meta.get(b.line)?.order ?? 0);
    const sorted = [...known].sort((a, b) =>
      sort === "early"
        ? (a.last ?? 0) - (b.last ?? 0) || byLine(a, b)
        : sort === "late"
          ? (b.last ?? 0) - (a.last ?? 0) || byLine(a, b)
          : byLine(a, b),
    );
    // 시간표가 없는 노선은 늘 맨 아래.
    return [...sorted, ...[...unknown].sort(byLine)];
  };

  function render(rows: LineLast[], now: number, dayLabel: string): void {
    day.textContent = dayLabel;

    const known = rows.filter((r): r is LineLast & { last: number } => r.last !== null);
    const running = known.filter((r) => r.last > now);
    const next = [...running].sort((a, b) => a.last - b.last)[0];
    summary.textContent = "";
    const counts = document.createElement("span");
    counts.textContent = `운행 중 ${running.length} · 종료 ${known.length - running.length}`;
    summary.appendChild(counts);
    if (next) {
      const hint = document.createElement("span");
      hint.textContent = `다음 막차 ${meta.get(next.line)?.name ?? next.line} ${clock(next.last)}`;
      summary.appendChild(hint);
    }

    list.replaceChildren(...ordered(rows).map((r) => row(r, now)));
  }

  return {
    setOpen(open) {
      root.hidden = !open;
      if (open && last) render(last.rows, last.now, last.dayLabel);
    },
    update(rows, now, dayLabel) {
      last = { rows, now, dayLabel };
      if (!root.hidden) render(rows, now, dayLabel);
    },
  };
}

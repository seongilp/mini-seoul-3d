/**
 * API 역명과 network.json 역명은 표기가 조금씩 다르다.
 *   "서울역" ↔ "서울", "쌍용(나사렛대)" ↔ "쌍용", "4.19 민주묘지" ↔ "4·19민주묘지"
 * 노선을 먼저 좁힌 뒤에 비교하므로, 괄호를 떼면서 생기는 동명이역 충돌은 문제되지 않는다.
 */
export function normalizeName(name: string): string {
  return name
    .replace(/\(.*?\)/g, "")
    .replace(/[·.]/g, "")
    .replace(/\s+/g, "")
    .replace(/역$/, "");
}

/**
 * API 역명에는 운행 정보가 접미로 붙는다.
 *   "성수종착" "왕십리행" "청량리방면" "성수지선" "응암순환"
 * 다만 "지행"처럼 접미와 글자가 겹치는 실제 역명이 있으므로, 이 함수의 결과는
 * 원본 이름으로 먼저 찾아본 뒤의 2순위 후보로만 써야 한다.
 */
export function stripOperationSuffix(name: string): string {
  let out = name.replace(/\(.*?\)/g, "").trim();
  for (;;) {
    const next = out.replace(/(종착|행|방면|지선|순환|급행)$/, "").trim();
    if (next === out || next === "") return out;
    out = next;
  }
}

/**
 * 개명된 역. API 는 새 이름을, network.json 은 옛 이름을 쓰는 경우를 잇는다.
 * 키·값 모두 normalizeName 을 통과한 형태다.
 */
const ALIASES: Record<string, string> = {
  불암산: "당고개",
};

/** 매칭에 시도할 이름 후보를 우선순위대로 돌려준다. */
export function nameCandidates(raw: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v);
  };

  const direct = normalizeName(raw);
  push(direct);
  push(ALIASES[direct] ?? "");

  const stripped = normalizeName(stripOperationSuffix(raw));
  push(stripped);
  push(ALIASES[stripped] ?? "");

  return out;
}

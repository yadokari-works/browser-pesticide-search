/**
 * 使用時期・使用回数の読み取り (DOM に依存しない)
 * - preharvestDays / preharvestText: 使用時期の文から収穫前日数を取り出す
 * - totalUsageFor: 適用行の成分ごとの総使用回数
 * - summarizeUsage: 検索結果の一覧に出す、適用行の収穫前日数・使用回数のまとめ
 */

// 「収穫7日前まで」「収穫開始14日前まで」「収穫開始1年前まで」「収穫前日まで」「…~収穫前日」。
// 「収穫後」「収穫終了後」「収穫直前まで」などは日数ではないので取り出さない (使用時期の欄で原文を見る)
const PREHARVEST_RE = /収穫(開始)?(?:(\d+)(日|年)前|(前日))/g;

function sameDays(x, y) {
  return x.n === y.n && x.unit === y.unit && x.start === y.start;
}

/** 使用時期の文に現れる収穫前日数。[{ n, unit, start }] の配列 (同じものは 1 つにまとめる)。無ければ [] */
export function preharvestDays(timing) {
  const out = [];
  for (const m of String(timing || "").matchAll(PREHARVEST_RE)) {
    const d = m[4]
      ? { n: 1, unit: "日", start: !!m[1] }
      : { n: Number(m[2]), unit: m[3], start: !!m[1] };
    if (!out.some(x => sameDays(x, d))) out.push(d);
  }
  return out;
}

/** 収穫前日数 1 つの表示 ("7日"、"14日 (収穫開始前)") */
function preharvestItemText(d) {
  return `${d.n}${d.unit}` + (d.start ? " (収穫開始前)" : "");
}

/** 使用時期の文から取り出した収穫前日数の表示。2 つ以上あれば "・" でつなぐ。無ければ "" */
export function preharvestText(timing) {
  return preharvestDays(timing).map(preharvestItemText).join("・");
}

/**
 * 適用行の i 番目の成分 (商品の total_usage_names の順) の総使用回数。applications.json は、
 * どの成分の総使用回数も本剤の使用回数と同じ行の totals を省き、総使用回数が無い行は空の配列にしている (build_data.py)
 */
export function totalUsageFor(a, i) {
  if (!a.totals) return a.count || "";
  return a.totals[i] || "";
}

/**
 * 適用行の収穫前日数・本剤の使用回数・成分ごとの総使用回数をまとめる (検索結果の一覧用)。
 * - days: 収穫前日数の表示。全部が収穫からの日数なら "1日" や "1〜7日"、収穫開始からの日数などが混ざれば並べる
 * - otherTimings: 収穫前日数を書いていない行の使用時期 (原文、重複なし)
 * - counts: 本剤の使用回数 (重複なし)
 * - totals: [{ name, values }] 成分ごとの総使用回数 (重複なし。値の無い成分は除く)
 * FAMIC が値の無いことを表す "-" は値として数えない。
 */
export function summarizeUsage(apps, names = []) {
  const items = [];
  const otherTimings = [];
  const counts = [];
  const totals = names.map(name => ({ name, values: [] }));
  const add = (list, v) => {
    if (v && v !== "-" && !list.includes(v)) list.push(v);
  };
  for (const a of apps) {
    const ds = preharvestDays(a.timing);
    if (ds.length) {
      for (const d of ds) if (!items.some(x => sameDays(x, d))) items.push(d);
    } else {
      add(otherTimings, a.timing);
    }
    add(counts, a.count);
    totals.forEach((t, i) => add(t.values, totalUsageFor(a, i)));
  }
  let days = "";
  if (items.length && items.every(d => d.unit === "日" && !d.start)) {
    const ns = items.map(d => d.n);
    const lo = Math.min(...ns);
    const hi = Math.max(...ns);
    days = lo === hi ? `${lo}日` : `${lo}〜${hi}日`;
  } else if (items.length) {
    const unitDays = d => d.n * (d.unit === "年" ? 365 : 1);
    days = [...items]
      .sort((x, y) => (x.start - y.start) || (unitDays(x) - unitDays(y)))
      .map(preharvestItemText).join("・");
  }
  return {
    rows: apps.length,
    days,
    otherTimings,
    counts,
    totals: totals.filter(t => t.values.length),
  };
}

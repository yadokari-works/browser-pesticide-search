/**
 * フィルタリング
 * - 用途カテゴリ (殺虫剤/殺菌剤/除草剤)
 * - 家庭向け除外
 * - 屋号付き (同一処方の代理店/OEM品) 除外 (同じグループの屋号の無い商品が結果にあるときだけ)
 * - 剤型マルチセレクト
 * - 混合剤のみ
 */

import { normalize, membersHave, entryHasCrop, entryHasPest } from "./normalize.js";

export const DEFAULT_FILTERS = {
  categories: new Set(["殺虫剤", "殺菌剤", "除草剤"]),
  statuses: new Set(["有効", "失効"]),  // デフォルト両方表示
  excludeHousehold: true,
  excludeBranded: true,  // 屋号付き (同一処方の代理店/OEM品) を除外
  formulations: null,  // null = すべて
  mixOnly: false,
  crop: "",    // 作物名 (部分一致)
  pest: "",    // 対象病害虫・雑草名 (部分一致)
};

/** 成分構成 (成分名 + 濃度) の署名。同一種類名でも濃度違いは別グループにするために使う */
export function ingredientSignature(p) {
  return (p.ingredients || [])
    .map(i => `${i.name}\u001f${i.density || ""}`)
    .sort()
    .join("\u001e");
}

/** 一覧で 1 枚のカードにまとめるグループ (種類名 + 成分構成) のキー */
export function groupKeyOf(p) {
  return `${p.type_name || p.product_name}\u001d${ingredientSignature(p)}`;
}

/**
 * 「屋号付き」商品 (同一処方・同一種類名の中で、他社の商品名をそのまま含む形の
 * 代理店/OEM 品) を検出し、p._branded に真偽値を立てる。p._group にはグループのキーを入れる。
 * 例: 種類名+成分構成が同じグループ内で "クミアイダコニール1000" は
 *     "ダコニール1000" (同グループの別商品) を末尾に含む → 屋号付きと判定。
 * どの商品も他の商品名を含まないグループは何も除外しない (誤除外を避けるため)。
 */
export function attachBrandedFlags(products) {
  const groups = new Map();
  for (const p of products) {
    const key = groupKeyOf(p);
    p._group = key;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(p);
  }
  for (const g of groups.values()) {
    for (const p of g) {
      p._branded = g.some(q =>
        q !== p &&
        p.product_name !== q.product_name &&
        p.product_name.length > q.product_name.length &&
        p.product_name.endsWith(q.product_name)
      );
    }
  }
}

export function applyFilters(products, filters) {
  const cropQ = filters.crop ? normalize(filters.crop) : "";
  const pestQ = filters.pest ? normalize(filters.pest) : "";
  const passed = products.filter(p => {
    // カテゴリ: p.categories のいずれかが選択中なら通す
    const cats = p.categories || [p.category];  // 旧スキーマ互換
    if (!cats.some(c => filters.categories.has(c))) return false;
    if (filters.statuses && !filters.statuses.has(p.status || "有効")) return false;
    if (filters.excludeHousehold && p.household) return false;
    if (filters.formulations && !filters.formulations.has(p.formulation)) return false;
    if (filters.mixOnly && p.ingredients.length < 2) return false;
    // 作物と病害虫を同時指定した場合は「同一適用行」での共起を要求する。
    // (別々の行で 作物→別病害虫 / 別作物→病害虫 に登録があるだけの商品を除外)
    // 作物欄が作物群の行は、所属作物との完全一致でも作物が一致したとみなす。
    // 病害虫は除外の括弧を除いた病害虫欄で見る (_app_pairs は search.js の app_entries)。
    const pairs = p._app_pairs || [];
    if (cropQ && pestQ) {
      if (!pairs.some(e => entryHasCrop(e, cropQ) && entryHasPest(e, pestQ))) return false;
    } else {
      if (cropQ && !(((p._crops_norm || "").includes(cropQ) || membersHave(p._crop_members, cropQ)) &&
        pairs.some(e => entryHasCrop(e, cropQ)))) return false;
      if (pestQ && !(p._pests_norm || "").includes(pestQ)) return false;
    }
    return true;
  });
  if (!filters.excludeBranded) return passed;
  // 屋号付きの商品は、同じグループの屋号の無い商品が結果に残っているときだけ隠す。
  // 登録 (適用) は商品ごとに違うため、その商品にしか無い登録で一致したときは表示する
  // (例: "ヤシ類 タイワンカブトムシ" の サンケイダイアジノン粒剤5)。
  const plainGroups = new Set(passed.filter(p => !p._branded).map(p => p._group));
  return passed.filter(p => !p._branded || !plainGroups.has(p._group));
}

/** 剤型の出現回数マップ */
export function countFormulations(products) {
  const m = new Map();
  for (const p of products) {
    const k = p.formulation || "(不明)";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
}

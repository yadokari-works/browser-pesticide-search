/**
 * フィルタリング
 * - 用途カテゴリ (殺虫剤/殺菌剤/除草剤)
 * - 家庭向け除外
 * - 剤型マルチセレクト
 * - 混合剤のみ
 */

import { normalize } from "./normalize.js";

export const DEFAULT_FILTERS = {
  categories: new Set(["殺虫剤", "殺菌剤", "除草剤"]),
  statuses: new Set(["有効", "失効"]),  // デフォルト両方表示
  excludeHousehold: true,
  formulations: null,  // null = すべて
  mixOnly: false,
  crop: "",    // 作物名 (部分一致)
  pest: "",    // 対象病害虫・雑草名 (部分一致)
};

export function applyFilters(products, filters) {
  const cropQ = filters.crop ? normalize(filters.crop) : "";
  const pestQ = filters.pest ? normalize(filters.pest) : "";
  return products.filter(p => {
    // カテゴリ: p.categories のいずれかが選択中なら通す
    const cats = p.categories || [p.category];  // 旧スキーマ互換
    if (!cats.some(c => filters.categories.has(c))) return false;
    if (filters.statuses && !filters.statuses.has(p.status || "有効")) return false;
    if (filters.excludeHousehold && p.household) return false;
    if (filters.formulations && !filters.formulations.has(p.formulation)) return false;
    if (filters.mixOnly && p.ingredients.length < 2) return false;
    if (cropQ && !(p._crops_norm || "").includes(cropQ)) return false;
    if (pestQ && !(p._pests_norm || "").includes(pestQ)) return false;
    return true;
  });
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

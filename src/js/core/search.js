/**
 * 検索エンジン
 * - スペース区切りの AND 検索
 * - 各トークンは商品名／成分名／会社名／種類名／作物名／病害虫名／RAC コードのいずれかに一致
 * - 全て正規化後の部分一致
 */

import { normalize, normalizeRacQuery } from "./normalize.js";

/**
 * 検索インデックス構築
 * @param {Array} products 商品配列
 * @param {Object} [applications] {登録番号: [{crop, pest, ...}, ...]} (省略可)
 */
export function buildIndex(products, applications) {
  const apps = applications || {};
  return products.map(p => {
    const ingredientNames = p.ingredients.map(i => normalize(i.name)).join("|");
    const racCodes = p.ingredients
      .map(i => (i.rac_code || "").split(/[,,]/).map(normalizeRacQuery))
      .flat()
      .filter(Boolean);

    // 作物名・病害虫名 (dedup + 結合)
    const entries = apps[String(p.reg_no)] || [];
    const cropSet = new Set();
    const pestSet = new Set();
    for (const a of entries) {
      if (a.crop) cropSet.add(normalize(a.crop));
      if (a.place) cropSet.add(normalize(a.place));
      if (a.pest) pestSet.add(normalize(a.pest));
    }
    const norm_crops = [...cropSet].join("|");
    const norm_pests = [...pestSet].join("|");

    return {
      product: p,
      norm_name: normalize(p.product_name),
      norm_company: normalize(p.company),
      norm_ingredients: ingredientNames,
      norm_type: normalize(p.type_name),
      norm_crops,
      norm_pests,
      rac_codes: racCodes,
      reg_no: p.reg_no,
    };
  });
}

/**
 * 1トークンが商品にヒットするか
 * テキスト部分一致 (複数フィールド OR) か、RAC コード一致 (プレフィックス可)
 */
function tokenMatches(token, entry) {
  const trimmed = token.trim();
  if (!trimmed) return true;

  // RAC コード風 (4A, M7, IRAC 4A 等) は RAC にもかける
  const racTarget = normalizeRacQuery(trimmed);
  const looksLikeRac =
    /^(IRAC|FRAC|HRAC)\s*/i.test(trimmed) ||
    (/^[0-9A-Z]{1,4}$/i.test(trimmed) && /[0-9]/.test(trimmed)) ||
    (/^[0-9]+$/.test(trimmed) && trimmed.length <= 2);

  if (looksLikeRac && racTarget) {
    if (entry.rac_codes.some(c => c === racTarget || c.startsWith(racTarget))) {
      return true;
    }
  }

  const nt = normalize(trimmed);
  if (!nt) return false;
  return (
    entry.norm_name.includes(nt) ||
    entry.norm_ingredients.includes(nt) ||
    entry.norm_company.includes(nt) ||
    entry.norm_type.includes(nt) ||
    entry.norm_crops.includes(nt) ||
    entry.norm_pests.includes(nt)
  );
}

/**
 * 入力を空白で分割し、各トークンがヒットする商品だけを返す (AND 検索)。
 * 空入力は全件。
 */
export function search(query, index) {
  const q = (query || "").trim();
  if (!q) return index.map(e => e.product);

  // 全角・半角スペース、タブで分割
  // "IRAC" / "FRAC" / "HRAC" 単独トークンは RAC コード指示語なのでスキップ
  //   (例: "IRAC 4A" → ["4A"] として扱う)
  const tokens = q
    .split(/[\s　]+/)
    .filter(Boolean)
    .filter(t => !/^(IRAC|FRAC|HRAC)$/i.test(t));
  if (tokens.length === 0) return index.map(e => e.product);

  return index
    .filter(entry => tokens.every(t => tokenMatches(t, entry)))
    .map(e => e.product);
}

/** 互換用: 旧 detectType を参照する呼出しがあれば簡易応答 */
export function detectType(query) {
  const q = (query || "").trim();
  if (!q) return "empty";
  if (/\s/.test(q)) return "and";
  return "text";
}

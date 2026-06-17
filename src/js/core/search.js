/**
 * 検索エンジン
 * - スペース区切りの AND 検索
 * - 各トークンは商品名／成分名／会社名／種類名／作物名／病害虫名／RAC コードのいずれかに一致
 * - 全て正規化後の部分一致
 */

import { normalize, normalizeRacQuery, expandSearchableCrops, splitRacCode } from "./normalize.js";

/**
 * 検索インデックス構築
 * @param {Array} products 商品配列
 * @param {Object} [applications] {登録番号: [{crop, pest, ...}, ...]} (省略可)
 */
export function buildIndex(products, applications) {
  const apps = applications || {};
  return products.map(p => {
    const ingredientNames = p.ingredients.map(i => normalize(i.name)).join("|");
    // IRAC/FRAC/HRAC 別に分類（コードは系統をまたいで数値が衝突するため、
    // "all" は自動モード用、I/F/H は系統指定検索用）
    const racCodes = { all: [], I: [], F: [], H: [] };
    for (const ing of p.ingredients) {
      const split = splitRacCode(ing.rac_code, p.categories || [p.category]);
      for (const sys of ["I", "F", "H"]) {
        for (const code of split[sys]) {
          const norm = normalizeRacQuery(code);
          if (!norm) continue;
          racCodes[sys].push(norm);
          racCodes.all.push(norm);
        }
      }
    }

    // 作物名・病害虫名 (dedup + 結合)
    const entries = apps[String(p.reg_no)] || [];
    const cropSet = new Set();
    const pestSet = new Set();
    for (const a of entries) {
      if (a.crop) {
        for (const c of expandSearchableCrops(a.crop)) cropSet.add(normalize(c));
      }
      if (a.place) {
        for (const c of expandSearchableCrops(a.place)) cropSet.add(normalize(c));
      }
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
 * @param {string|null} racSystem "I"|"F"|"H"|null。null/省略時は全系統 (all) を対象。
 *   トークン側に "IRAC"/"FRAC"/"HRAC" 明示プレフィックスがあればそちらを優先する。
 */
function tokenMatches(token, entry, racSystem) {
  const trimmed = token.trim();
  if (!trimmed) return true;

  // RAC コード風 (4A, M7, IRAC 4A 等) は RAC にもかける
  const racTarget = normalizeRacQuery(trimmed);
  const looksLikeRac =
    /^(IRAC|FRAC|HRAC)\s*/i.test(trimmed) ||
    (/^[0-9A-Z]{1,4}$/i.test(trimmed) && /[0-9]/.test(trimmed)) ||
    (/^[0-9]+$/.test(trimmed) && trimmed.length <= 2);

  if (looksLikeRac && racTarget) {
    const prefixMatch = trimmed.match(/^(IRAC|FRAC|HRAC)/i);
    const sysFromPrefix = prefixMatch
      ? { IRAC: "I", FRAC: "F", HRAC: "H" }[prefixMatch[1].toUpperCase()]
      : null;
    const sys = sysFromPrefix || racSystem;
    const pool = sys ? entry.rac_codes[sys] : entry.rac_codes.all;
    if (pool.some(c => c === racTarget || c.startsWith(racTarget))) {
      return true;
    }
    // 系統が明示指定されている場合 (ラジオボタン選択 or "IRAC 4A" 等のプレフィックス) は
    // RAC コード一致のみで判定を確定させ、商品名等への通常テキスト一致にフォールスルーしない。
    // ("自動" でプレフィックス無しの場合は従来通りテキスト一致もフォールバックとして許容)
    if (sys) {
      return false;
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

const RAC_PREFIX_TO_SYS = { IRAC: "I", FRAC: "F", HRAC: "H" };

/**
 * 入力を空白で分割し、各トークンがヒットする商品だけを返す (AND 検索)。
 * 空入力は全件。
 * @param {string|null} [racSystem] "I"|"F"|"H"|null。数字単独などの RAC コード
 *   風トークンを、指定した系統 (IRAC/FRAC/HRAC) 内だけで一致させる。
 */
export function search(query, index, racSystem) {
  const q = (query || "").trim();
  if (!q) return index.map(e => e.product);

  // 全角・半角スペース、タブで分割。
  // "IRAC" / "FRAC" / "HRAC" 単独トークンは RAC コード指示語なので、
  // 直後のトークンへ系統指定として引き継がせてから取り除く
  //   (例: "IRAC 4A" → 4A を IRAC 限定で検索。ラジオボタンの選択より優先)
  const rawTokens = q.split(/[\s　]+/).filter(Boolean);
  const tokens = [];
  let pendingSys = null;
  for (const t of rawTokens) {
    const m = t.match(/^(IRAC|FRAC|HRAC)$/i);
    if (m) {
      pendingSys = RAC_PREFIX_TO_SYS[m[1].toUpperCase()];
      continue;
    }
    tokens.push({ text: t, sys: pendingSys });
    pendingSys = null;
  }
  if (tokens.length === 0) return index.map(e => e.product);

  return index
    .filter(entry => tokens.every(t => tokenMatches(t.text, entry, t.sys || racSystem)))
    .map(e => e.product);
}

/** 互換用: 旧 detectType を参照する呼出しがあれば簡易応答 */
export function detectType(query) {
  const q = (query || "").trim();
  if (!q) return "empty";
  if (/\s/.test(q)) return "and";
  return "text";
}

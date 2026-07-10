/**
 * 検索エンジン
 * - スペース区切りの AND / OR 検索 (mode で切替。既定は AND)
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
  // コーパス全体の「正規化した完全一致の作物名／病害虫名」語彙。
  // クエリ語の役割 (作物 or 病害虫) を、その商品内の部分一致だけに頼らず判定するために使う。
  //   例: "なす" は作物語彙に存在する → たとえある商品で病害虫名 "ヨメナスジハモグリバエ" に
  //       部分一致しても、作物トークンとして扱える。
  const cropWords = new Set();
  const pestWords = new Set();
  for (const k in apps) {
    for (const a of apps[k]) {
      if (a.crop) for (const c of expandSearchableCrops(a.crop)) cropWords.add(normalize(c));
      if (a.place) for (const c of expandSearchableCrops(a.place)) cropWords.add(normalize(c));
      if (a.pest) pestWords.add(normalize(a.pest));
    }
  }

  const index = products.map(p => {
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

    // 作物名・病害虫名
    // - norm_crops / norm_pests: 商品全体で dedup 結合 (OR 検索・トークン分類用)
    // - app_entries: 適用行ごとに crop/pest を分離保持 (AND の作物×病害虫 共起判定用)
    const entries = apps[String(p.reg_no)] || [];
    const cropSet = new Set();
    const pestSet = new Set();
    const app_entries = [];
    for (const a of entries) {
      const cparts = [];
      if (a.crop) {
        for (const c of expandSearchableCrops(a.crop)) { const n = normalize(c); cropSet.add(n); cparts.push(n); }
      }
      if (a.place) {
        for (const c of expandSearchableCrops(a.place)) { const n = normalize(c); cropSet.add(n); cparts.push(n); }
      }
      const pestNorm = a.pest ? normalize(a.pest) : "";
      if (pestNorm) pestSet.add(pestNorm);
      app_entries.push({ crop: cparts.join("|"), pest: pestNorm });
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
      app_entries,
      rac_codes: racCodes,
      reg_no: p.reg_no,
    };
  });
  // 語彙をインデックス配列に添付 (search() が役割判定に参照)
  index.lexicon = { cropWords, pestWords };
  return index;
}

/**
 * 1トークンを「商品レベル (作物・病害虫以外)」で判定する。
 * 戻り値:
 *   "yes"   … 商品名／成分／会社名／種類名／RAC コードに一致 (どの適用行でも成立)
 *   "no"    … RAC 系統が明示指定されコード不一致、または空トークン → この商品では確定的に不成立
 *   "maybe" … 商品レベルでは一致せず。作物・病害虫 (適用行) 側での判定に委ねる
 * @param {string|null} racSystem "I"|"F"|"H"|null。トークンの "IRAC"/"FRAC"/"HRAC"
 *   プレフィックスがあればそちらを優先する。
 */
function classifyNonApp(token, entry, racSystem) {
  const trimmed = token.trim();
  if (!trimmed) return "yes";

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
      return "yes";
    }
    // 系統が明示指定されている場合 (ラジオボタン選択 or "IRAC 4A" 等のプレフィックス) は
    // RAC コード一致のみで判定を確定させ、商品名・作物名等へのテキスト一致にフォールスルーしない。
    // ("自動" でプレフィックス無しの場合は従来通りテキスト一致もフォールバックとして許容)
    if (sys) {
      return "no";
    }
  }

  const nt = normalize(trimmed);
  if (!nt) return "no";
  if (
    entry.norm_name.includes(nt) ||
    entry.norm_ingredients.includes(nt) ||
    entry.norm_company.includes(nt) ||
    entry.norm_type.includes(nt)
  ) {
    return "yes";
  }
  return "maybe";
}

/** OR 用: 1トークンが商品のどこか (商品レベル or 作物 or 病害虫) に一致するか */
function tokenMatchesAnywhere(token, entry, racSystem) {
  const r = classifyNonApp(token, entry, racSystem);
  if (r === "yes") return true;
  if (r === "no") return false;
  const nt = normalize(token.trim());
  return !!nt && (entry.norm_crops.includes(nt) || entry.norm_pests.includes(nt));
}

/**
 * AND 用: 商品が全トークン条件を満たすか。
 * - 商品レベルトークン (成分・商品名・RAC 等) は適用行に依らず判定。
 * - 作物トークンと病害虫トークンは、そのペアが「同一の適用行」に共起することを要求する
 *   (例: "ぶどう うどんこ病" → ぶどうに対してうどんこ病が登録されている適用行が必要。
 *    別々の行で ぶどう→すす点病 / なす→うどんこ病 でも一致、という誤ヒットを防ぐ)。
 * - 作物×作物 / 病害虫×病害虫 のように片側しか無い組は従来どおり独立 AND (商品全体に存在すれば可)。
 * - トークンの役割 (作物 or 病害虫) はコーパス語彙 (lex) で判定し、判別不能な語だけ
 *   その商品内の出現フィールドで補う。これにより "なす" が病害虫名 "ヨメナスジ…" に部分一致
 *   しても作物として扱える。
 * @param {{cropWords:Set<string>, pestWords:Set<string>}} lex コーパス語彙
 */
function matchesAnd(entry, tokens, racSystem, lex) {
  const cropTokens = [];
  const pestTokens = [];
  for (const t of tokens) {
    const r = classifyNonApp(t.text, entry, t.sys || racSystem);
    if (r === "yes") continue;      // 商品レベルで充足
    if (r === "no") return false;   // 確定的に不成立
    // "maybe": 作物・病害虫側で存在を確認
    const nt = normalize(t.text.trim());
    if (!nt) return false;
    const isCropField = entry.norm_crops.includes(nt);
    const isPestField = entry.norm_pests.includes(nt);
    if (!isCropField && !isPestField) return false;  // どこにも無い → 不成立

    // 役割決定: コーパス語彙を優先し、曖昧語のみ商品内フィールドで補う
    const cropWord = lex.cropWords.has(nt);
    const pestWord = lex.pestWords.has(nt);
    if (cropWord && !pestWord) cropTokens.push(nt);
    else if (pestWord && !cropWord) pestTokens.push(nt);
    else if (isCropField && !isPestField) cropTokens.push(nt);
    else if (isPestField && !isCropField) pestTokens.push(nt);
    else { cropTokens.push(nt); pestTokens.push(nt); }  // 判別不能 → どちらの役割でも許容
  }
  // 作物×病害虫ペアが「同一適用行」に共起することを要求。
  // 作物名が病害虫欄の括弧内 (例 "うどんこ病(ぶどう)") にある場合も拾えるよう、
  // 各適用行の crop/pest を結合したテキストで両トークンの有無を見る。
  for (const c of cropTokens) {
    for (const p of pestTokens) {
      if (c === p) continue;
      const ok = entry.app_entries.some(e =>
        (e.crop.includes(c) || e.pest.includes(c)) &&
        (e.crop.includes(p) || e.pest.includes(p))
      );
      if (!ok) return false;
    }
  }
  return true;
}

const EMPTY_LEX = { cropWords: new Set(), pestWords: new Set() };

const RAC_PREFIX_TO_SYS = { IRAC: "I", FRAC: "F", HRAC: "H" };

/**
 * 入力を空白で分割し、各トークンの一致条件で商品を絞り込んで返す。
 * 空入力は全件。
 * @param {string|null} [racSystem] "I"|"F"|"H"|null。数字単独などの RAC コード
 *   風トークンを、指定した系統 (IRAC/FRAC/HRAC) 内だけで一致させる。
 * @param {"and"|"or"} [mode="and"] トークン結合方法。
 *   "and" = 全トークンに一致する商品のみ (既定)。
 *   "or"  = いずれかのトークンに一致する商品。
 */
export function search(query, index, racSystem, mode) {
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

  // OR 検索: いずれかのトークンに一致すれば採用。
  // AND 検索: 全トークン一致。ただし作物×病害虫は同一適用行での共起を要求 (matchesAnd)。
  const lex = index.lexicon || EMPTY_LEX;
  const combine = mode === "or"
    ? (entry) => tokens.some(t => tokenMatchesAnywhere(t.text, entry, t.sys || racSystem))
    : (entry) => matchesAnd(entry, tokens, racSystem, lex);

  return index.filter(combine).map(e => e.product);
}

/** 互換用: 旧 detectType を参照する呼出しがあれば簡易応答 */
export function detectType(query) {
  const q = (query || "").trim();
  if (!q) return "empty";
  if (/\s/.test(q)) return "and";
  return "text";
}

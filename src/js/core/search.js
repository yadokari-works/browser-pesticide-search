/**
 * 検索エンジン
 * - スペース区切りの AND / OR 検索 (mode で切替。既定は AND)
 * - 各トークンは商品名／成分名／会社名／種類名／作物名／病害虫名／RAC コードのいずれかに一致
 * - 全て正規化後の部分一致
 */

import { normalize, normalizeRacQuery, expandSearchableCrops, splitRacCode, applicationCropMembers, membersHave } from "./normalize.js";

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
  // cropWords は作物欄に実際に書かれた作物名だけ。作物群の所属作物と作物の別名
  // (例 非結球あぶらな科葉菜類 → こまつな、みずな → 京菜) は virtualCropWords に分けて持ち、
  // 役割は商品ごとの一致で決める。所属作物・別名まで作物語にすると、"アザミ" (花き類の所属作物) や
  // "クロウリ" (しろうりの別名) が常に作物と決まり、アザミウマ・クロウリハムシのつもりの検索で
  // 作物×病害虫の同一行判定が外れるため。
  const cropWords = new Set();
  const pestWords = new Set();
  const virtualCropWords = new Set();
  const seenMembers = new Set();
  for (const k in apps) {
    for (const a of apps[k]) {
      if (a.crop) for (const c of expandSearchableCrops(a.crop)) cropWords.add(normalize(c));
      if (a.place) for (const c of expandSearchableCrops(a.place)) cropWords.add(normalize(c));
      for (const s of applicationCropMembers(a)) {
        if (seenMembers.has(s)) continue;
        seenMembers.add(s);
        for (const m of s) virtualCropWords.add(m);
      }
      if (a.pest) pestWords.add(normalize(a.pest));
    }
  }
  // 病害虫名を "、" "・" などで区切った各語 (括弧の内側では区切らない)。
  // 検索語が病害虫名の頭に現れるか (アザミ → アザミウマ類) の判定に使う。
  const pestHeads = [];
  for (const w of pestWords) pestHeads.push(...splitPestName(w));

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
    // - crop_members / app_entries[].members: 作物欄の作物名で引ける語の Set
    //   (作物群の所属作物とその別名、作物群でない作物の別名。完全一致で照合する)
    const entries = apps[String(p.reg_no)] || [];
    const cropSet = new Set();
    const pestSet = new Set();
    const memberSets = new Set();
    const app_entries = [];
    for (const a of entries) {
      const cparts = [];
      if (a.crop) {
        for (const c of expandSearchableCrops(a.crop)) { const n = normalize(c); cropSet.add(n); cparts.push(n); }
      }
      if (a.place) {
        for (const c of expandSearchableCrops(a.place)) { const n = normalize(c); cropSet.add(n); cparts.push(n); }
      }
      const members = applicationCropMembers(a);
      for (const s of members) memberSets.add(s);
      const pestNorm = a.pest ? normalize(a.pest) : "";
      if (pestNorm) pestSet.add(pestNorm);
      app_entries.push({ crop: cparts.join("|"), pest: pestNorm, members });
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
      crop_members: [...memberSets],
      app_entries,
      rac_codes: racCodes,
      reg_no: p.reg_no,
    };
  });
  // 語彙をインデックス配列に添付 (search() が役割判定に参照)
  index.lexicon = { cropWords, pestWords, virtualCropWords, pestHeads, stemCache: new Map() };
  return index;
}

/** 正規化済みの病害虫名を、括弧の外側の "、" "・" "," "/" で区切る */
function splitPestName(w) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of w) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && "、・,/".includes(ch)) { if (cur) out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * nt (正規化済み) が、コーパスのいずれかの病害虫名の語の頭に現れるか。
 * 例: "アザミ" (アザミウマ類)、"クロウリ" (クロウリハムシ)、"ジャガイモ" (ジャガイモガ)。
 * 病害虫名の括弧内の作物名 ("幹腐病(ユズ)" の ユズ) や語の途中 ("ヘルミントスポリウム" の ミント) は含めない。
 */
function isPestStem(nt, lex) {
  if (!lex.pestHeads) return false;
  let v = lex.stemCache.get(nt);
  if (v === undefined) {
    v = lex.pestHeads.some(h => h.startsWith(nt));
    lex.stemCache.set(nt, v);
  }
  return v;
}

/** 作物と確定する検索語か: 作物欄の作物名 (病害虫名と完全一致しない)、または病害虫名の頭に現れない所属作物・別名 */
function isCropToken(nt, lex) {
  return (lex.cropWords.has(nt) && !lex.pestWords.has(nt))
    || (!!lex.virtualCropWords && lex.virtualCropWords.has(nt) && !isPestStem(nt, lex));
}

/**
 * 検索語ごとに、作物欄と一致させてよいか (作物として扱えるか) を返す。
 * 病害虫名の頭にも現れる語 ("アザミ" → アザミウマ類、"クロウリ" → クロウリハムシ。作物欄に実際に
 * 書かれた作物名と完全一致する語は除く) は、作物の指定 (サイドバーの作物、または AND で他の検索語にある
 * 作物名) と一緒のときは病害虫として扱い、作物欄とは一致させない。作物群の所属作物・別名とも、
 * 作物名の一部 ("もりあざみ" の アザミ) とも一致させない。例: "なす アザミ" は なす のアザミウマ類。
 * 作物の指定が無いとき ("アザミ" だけ、"ジャガイモ アブラムシ") は、作物としても一致させる。
 * @param {string[]} nts 正規化済みの検索語
 */
function cropFlags(nts, lex, scopeCrop, mode) {
  return nts.map((nt, i) => {
    if (!nt || lex.cropWords.has(nt) || !isPestStem(nt, lex)) return true;
    const cropContext = !!scopeCrop ||
      (mode !== "or" && nts.some((u, j) => j !== i && u && isCropToken(u, lex)));
    return !cropContext;
  });
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

/**
 * 同一の適用行に作物・病害虫が共起するか。空文字の側は条件なし。
 * サイドバー指定の判定に使うため、作物は作物欄、病害虫は病害虫欄だけを見る
 * (病害虫名 "ナシヒメシンクイ" が作物 "なし" に部分一致して誤ヒットするのを防ぐ)。
 * 作物欄が作物群の行は所属作物、作物群でない行は別名との完全一致でも成立する。
 */
function rowHas(entry, cropQ, pestQ) {
  return entry.app_entries.some(e =>
    (!cropQ || e.crop.includes(cropQ) || membersHave(e.members, cropQ)) &&
    (!pestQ || e.pest.includes(pestQ))
  );
}

/**
 * 商品のいずれかの適用行の作物欄に nt があるか (所属作物・別名は完全一致)。
 * cropOK が false の語 (cropFlags で病害虫として扱うと決めた語) は作物欄と一致させない。
 */
function cropsHave(entry, nt, cropOK = true) {
  return cropOK && (entry.norm_crops.includes(nt) || membersHave(entry.crop_members, nt));
}

/**
 * OR 用: 1トークンが商品のどこか (商品レベル or 作物 or 病害虫) に一致するか。
 * サイドバーで作物 (または病害虫) が指定されている場合、病害虫語 (または作物語) は
 * 「その指定と同一の適用行」で成立したときだけ一致とする。
 *   例: 作物=なし、"黒星病 炭疽病" (OR) → なしの適用行に黒星病か炭疽病がある商品
 * @param {{text:string, cropOK:boolean}} token cropOK は cropFlags の値
 */
function tokenMatchesAnywhere(token, entry, racSystem, lex, scope) {
  const r = classifyNonApp(token.text, entry, racSystem);
  if (r === "yes") return true;
  if (r === "no") return false;
  const nt = normalize(token.text.trim());
  if (!nt) return false;
  const inCrops = cropsHave(entry, nt, token.cropOK);
  const inPests = entry.norm_pests.includes(nt);
  if (!inCrops && !inPests) return false;

  const cw = lex.cropWords.has(nt);
  const pw = lex.pestWords.has(nt);
  const asPest = (pw && !cw) || (!cw && !pw && inPests && !inCrops);
  const asCrop = (cw && !pw) || (!cw && !pw && inCrops && !inPests);
  if (scope.crop && asPest) return rowHas(entry, scope.crop, nt);
  if (scope.pest && asCrop) return rowHas(entry, nt, scope.pest);
  return true;
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
 *   しても作物として扱える。作物群の所属作物・別名だけで作物欄に一致する語も、商品内の出現で補う。
 *   cropFlags で病害虫として扱うと決めた語 (作物名と一緒の "アザミ" など) は、作物欄と一致させない。
 * @param {{cropWords:Set<string>, pestWords:Set<string>}} lex コーパス語彙
 */
function matchesAnd(entry, tokens, racSystem, lex, scope) {
  const cropTokens = [];
  const pestTokens = [];
  const ambiguous = new Set();
  const noCrop = new Set();  // 作物欄と一致させない語 (cropFlags)
  for (const t of tokens) {
    const r = classifyNonApp(t.text, entry, t.sys || racSystem);
    if (r === "yes") continue;      // 商品レベルで充足
    if (r === "no") return false;   // 確定的に不成立
    // "maybe": 作物・病害虫側で存在を確認
    const nt = normalize(t.text.trim());
    if (!nt) return false;
    if (!t.cropOK) noCrop.add(nt);
    const isCropField = cropsHave(entry, nt, t.cropOK);
    const isPestField = entry.norm_pests.includes(nt);
    if (!isCropField && !isPestField) return false;  // どこにも無い → 不成立

    // 役割決定: コーパス語彙を優先し、曖昧語のみ商品内フィールドで補う
    const cropWord = lex.cropWords.has(nt);
    const pestWord = lex.pestWords.has(nt);
    if (cropWord && !pestWord) cropTokens.push(nt);
    else if (pestWord && !cropWord) pestTokens.push(nt);
    else if (isCropField && !isPestField) cropTokens.push(nt);
    else if (isPestField && !isCropField) pestTokens.push(nt);
    else { cropTokens.push(nt); pestTokens.push(nt); ambiguous.add(nt); }  // 判別不能 → どちらの役割でも許容
  }
  // 作物×病害虫ペアが「同一適用行」に共起することを要求。
  // 作物名が病害虫欄の括弧内 (例 "うどんこ病(ぶどう)") にある場合も拾えるよう、
  // 各適用行の crop/pest を結合したテキストで両トークンの有無を見る。
  // 作物欄の所属作物・別名との完全一致でも作物があるとみなす。noCrop の語は病害虫欄だけを見る。
  const inRow = (e, t) => noCrop.has(t)
    ? e.pest.includes(t)
    : e.crop.includes(t) || e.pest.includes(t) || membersHave(e.members, t);
  for (const c of cropTokens) {
    for (const p of pestTokens) {
      if (c === p) continue;
      const ok = entry.app_entries.some(e => inRow(e, c) && inRow(e, p));
      if (!ok) return false;
    }
  }
  // サイドバーで作物を指定している場合、検索語の病害虫は「その作物の適用行」ごとに
  // 成立していなければならない (病害虫が複数でも、各病害虫が指定作物に登録されている)。
  // 病害虫を指定している場合の、検索語の作物も同様。
  if (scope.crop) {
    for (const p of pestTokens) {
      if (!ambiguous.has(p) && !rowHas(entry, scope.crop, p)) return false;
    }
  }
  if (scope.pest) {
    for (const c of cropTokens) {
      if (!ambiguous.has(c) && !rowHas(entry, c, scope.pest)) return false;
    }
  }
  return true;
}

const EMPTY_LEX = { cropWords: new Set(), pestWords: new Set(), virtualCropWords: new Set(), pestHeads: [], stemCache: new Map() };

const RAC_PREFIX_TO_SYS = { IRAC: "I", FRAC: "F", HRAC: "H" };

/**
 * 入力を空白で分割し、各トークンの一致条件で商品を絞り込んで返す。
 * 空入力は全件。
 * @param {string|null} [racSystem] "I"|"F"|"H"|null。数字単独などの RAC コード
 *   風トークンを、指定した系統 (IRAC/FRAC/HRAC) 内だけで一致させる。
 * @param {"and"|"or"} [mode="and"] トークン結合方法。
 *   "and" = 全トークンに一致する商品のみ (既定)。
 *   "or"  = いずれかのトークンに一致する商品。
 * @param {{crop?:string, pest?:string}} [scope] サイドバーで指定された作物・病害虫。
 *   検索語の病害虫は指定作物と、検索語の作物は指定病害虫と、同一の適用行で
 *   成立することを要求する (商品全体にそれぞれ別々に登録があるだけでは一致としない)。
 */
export function search(query, index, racSystem, mode, scope) {
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
  const sc = { crop: normalize((scope && scope.crop) || ""), pest: normalize((scope && scope.pest) || "") };
  const flags = cropFlags(tokens.map(t => normalize(t.text.trim())), lex, sc.crop, mode);
  tokens.forEach((t, i) => { t.cropOK = flags[i]; });
  const combine = mode === "or"
    ? (entry) => tokens.some(t => tokenMatchesAnywhere(t, entry, t.sys || racSystem, lex, sc))
    : (entry) => matchesAnd(entry, tokens, racSystem, lex, sc);

  return index.filter(combine).map(e => e.product);
}

/**
 * 結果の適用表を「指定した作物・病害虫の行だけ」に絞るための条件を作る。
 * サイドバーの作物・病害虫は常に必須。検索語のうち作物名・病害虫名として
 * コーパス語彙にある語を、AND なら「作物群・病害虫群のそれぞれに該当」、
 * OR なら「いずれかに該当」として扱う。商品名・成分名などの語は行の絞り込みに使わない。
 * 作物群の所属作物・別名は完全一致で作物とみなす。検索と同じく、cropFlags で病害虫として扱うと
 * 決めた語は作物にしない。
 * @param {{cropWords:Set<string>, pestWords:Set<string>}} lex コーパス語彙 (index.lexicon)
 */
export function buildRowCondition(query, lex, mode, scope) {
  const L = lex || EMPTY_LEX;
  const crops = [];
  const pests = [];
  const either = [];
  const noCrop = [];
  const scopeCrop = normalize((scope && scope.crop) || "");
  const has = (set, nt) => set.has(nt) || [...set].some(w => w.includes(nt));
  const nts = (query || "").trim().split(/[\s　]+/).filter(Boolean)
    .filter(raw => !/^(IRAC|FRAC|HRAC)$/i.test(raw))
    .map(raw => normalize(raw))
    .filter(Boolean);
  const flags = cropFlags(nts, L, scopeCrop, mode);
  nts.forEach((nt, i) => {
    const cropOK = flags[i];
    if (!cropOK) noCrop.push(nt);
    const cw = cropOK && (has(L.cropWords, nt) || (!!L.virtualCropWords && L.virtualCropWords.has(nt)));
    const pw = has(L.pestWords, nt);
    if (cw && pw) either.push(nt);
    else if (cw) crops.push(nt);
    else if (pw) pests.push(nt);
  });
  return {
    mode: mode === "or" ? "or" : "and",
    crops, pests, either, noCrop,
    scopeCrop,
    scopePest: normalize((scope && scope.pest) || ""),
  };
}

/** 行を絞る条件が 1 つでもあるか (無ければ全登録をそのまま表示する) */
export function hasRowCondition(cond) {
  return !!(cond && (cond.crops.length || cond.pests.length || cond.either.length ||
    cond.scopeCrop || cond.scopePest));
}

/** 適用行 (FAMIC 適用部の配列) を条件で絞り込む。条件が無ければそのまま返す */
export function filterApplications(apps, cond) {
  if (!hasRowCondition(cond)) return apps;
  const groups = [["crops", cond.crops], ["pests", cond.pests], ["either", cond.either]]
    .filter(([, list]) => list.length);
  return apps.filter(a => {
    const crop = [
      ...(a.crop ? expandSearchableCrops(a.crop) : []),
      ...(a.place ? expandSearchableCrops(a.place) : []),
    ].map(normalize).join("|");
    const members = applicationCropMembers(a);
    const noCrop = cond.noCrop || [];
    const cropHas = t => !noCrop.includes(t) && (crop.includes(t) || membersHave(members, t));
    const pest = a.pest ? normalize(a.pest) : "";
    if (cond.scopeCrop && !(crop.includes(cond.scopeCrop) || membersHave(members, cond.scopeCrop))) return false;
    if (cond.scopePest && !pest.includes(cond.scopePest)) return false;
    if (groups.length === 0) return true;
    const hit = {
      crops: cond.crops.some(cropHas),
      pests: cond.pests.some(t => pest.includes(t)),
      either: cond.either.some(t => cropHas(t) || pest.includes(t)),
    };
    return cond.mode === "or"
      ? groups.some(([k]) => hit[k])
      : groups.every(([k]) => hit[k]);
  });
}

/** 互換用: 旧 detectType を参照する呼出しがあれば簡易応答 */
export function detectType(query) {
  const q = (query || "").trim();
  if (!q) return "empty";
  if (/\s/.test(q)) return "and";
  return "text";
}

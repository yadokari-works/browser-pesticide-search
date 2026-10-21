/**
 * 抵抗性・耐性の報告の照合 (DOM に依存しない。scripts/test_resistance.mjs が Node から読む)
 * データは src/data/resistance.json (scripts/build_resistance.py が rawdata/resistance/ から作る)。
 *
 * 1. 種を決める (resolveTaxa): 病害虫名 → 病原菌・害虫・雑草の種。同じ病名でも作物で病原菌が違う
 *    (うどんこ病: きゅうりは Podosphaera xanthii、トマトは Pseudoidium neolycopersici など) ため、
 *    作物ごとの対応 → 作物群の対応 → 全作物 (*) の対応 → 和名が病害虫名と同じ種、の順に引く。
 *    どれにも無ければ「未登録」とし、推測で補わない。
 * 2. 報告を引く (findResistance): 種が同じで、成分が同じ (塩・水和物の語尾は無視) なら「同じ成分」、
 *    RAC コードが同じなら「同じ系統」。系統が同じでも交差抵抗性があるとは限らない (画面で注記する)。
 * 3. まとめる (summarizeResistance): 最も強い程度、県・国、最新の年。
 */

import { normalize, searchablePest, splitRacCode, cropGroupMembers, cropAliasSet, cropQueryForms } from "./normalize.js";

// 程度の 4 段階 (rawdata/resistance/README.md)。rank が大きいほど強い
export const RESISTANCE_LEVELS = {
  field_failure: { label: "効果低下", rank: 4 },
  resistant: { label: "抵抗性あり", rank: 3 },
  reduced: { label: "感受性低下", rank: 2 },
  not_detected: { label: "検出されず", rank: 1 },
};

// 成分名の名寄せで無視してよい語尾 (scripts/build_resistance.py の SALT_SUFFIXES と同じ)
const RES_SALT_SUFFIXES = [
  "ナトリウム塩", "カリウム塩", "アンモニウム塩", "カルシウム塩", "マグネシウム塩", "銅塩", "亜鉛塩",
  "イソプロピルアミン塩", "ジメチルアミン塩", "塩酸塩", "硫酸塩", "酢酸塩", "水和物", "塩",
].map(normalize).sort((a, b) => b.length - a.length);

// 作用機構が分からない・分類されないことを表すコード。同じコードでも同じ系統とはいえないので、系統の照合に使わない
const RES_NOT_A_GROUP = /^(UN.*|NC|0)$/;

/** 成分名から塩・水和物の語尾を除いた名前 (正規化済み)。グリホサートカリウム塩 → グリホサート */
export function ingredientStem(name) {
  const n = normalize(name);
  for (const suf of RES_SALT_SUFFIXES) {
    if (n.endsWith(suf) && n.length - suf.length >= 2) return n.slice(0, -suf.length);
  }
  return n;
}

/** resistance.json を照合しやすい形にする。data が無ければ空の索引を返す */
export function buildResistanceIndex(data) {
  const taxa = (data && data.taxa) || {};
  const pestMap = new Map();  // 病害虫名 (正規化) → pest_map の行 (cropNorm を付ける)
  for (const e of (data && data.pest_map) || []) {
    const key = normalize(searchablePest(e.pest));
    if (!pestMap.has(key)) pestMap.set(key, []);
    pestMap.get(key).push({ ...e, cropNorm: e.crop === "*" ? "*" : normalize(e.crop) });
  }
  const byJaName = new Map();  // 和名 (正規化) → 種 ID の配列
  for (const [id, t] of Object.entries(taxa)) {
    if (!t.ja) continue;
    const k = normalize(t.ja);
    if (!byJaName.has(k)) byJaName.set(k, []);
    byJaName.get(k).push(id);
  }
  const byTaxon = new Map();  // 種 ID → 報告の配列
  const records = (data && data.records) || [];
  for (const r of records) {
    if (!byTaxon.has(r.taxon)) byTaxon.set(r.taxon, []);
    byTaxon.get(r.taxon).push(r);
  }
  const sources = new Map(((data && data.sources) || []).map(s => [s.id, s]));
  return { taxa, pestMap, byJaName, byTaxon, sources, recordCount: records.length };
}

/**
 * 病害虫名 pest (適用行の原文でよい) と作物 crop から種を決める。crop は利用者が指定した作物、
 * 無ければ適用行の作物 (作物群や null でもよい)。
 * 戻り値 { taxa, basis, entries, cropSpecific }
 *   basis: "crop" 作物ごとの対応 / "group" 作物群の対応 / "any" 全作物の対応 / "name" 和名が同じ種 / null 未登録
 *   entries: 根拠にした pest_map の行
 *   cropSpecific: その病害虫名に作物ごとの対応がある (作物を指定しないと種が決まらないことがある)
 */
export function resolveTaxa(rx, crop, pest) {
  const p = normalize(searchablePest(pest));
  const entries = rx.pestMap.get(p) || [];
  const cropSpecific = entries.some(e => e.cropNorm !== "*");
  const result = (list, basis) => ({ taxa: [...new Set(list.flatMap(e => e.taxa))], basis, entries: list, cropSpecific });
  if (crop) {
    const forms = cropQueryForms(normalize(crop));
    const exact = entries.filter(e => e.cropNorm !== "*" &&
      forms.some(f => e.cropNorm === f || cropAliasSet(e.crop).has(f)));
    if (exact.length) return result(exact, "crop");
    const group = entries.filter(e => e.cropNorm !== "*" && forms.some(f => cropGroupMembers(e.crop).has(f)));
    if (group.length) return result(group, "group");
  }
  const any = entries.filter(e => e.cropNorm === "*");
  if (any.length) return result(any, "any");
  if (!entries.length) {
    const named = rx.byJaName.get(p);
    if (named) return { taxa: [...named], basis: "name", entries: [], cropSpecific: false };
  }
  return { taxa: [], basis: null, entries: [], cropSpecific };
}

/**
 * 病害虫名の一覧 names のうち、作物 crop で種 taxonIds のどれかに決まる名前。
 * 「ナミハダニ」を調べるとき、病害虫名の対応で ナミハダニ を含むとした「ハダニ類」の登録も数えるために使う。
 * 対応の無い群名は含まない (推測しない)。
 */
export function pestNamesForTaxa(rx, crop, names, taxonIds) {
  const want = new Set(taxonIds);
  return names.filter(n => resolveTaxa(rx, crop || null, n).taxa.some(id => want.has(id)));
}

/** 報告の宿主作物 host が、作物 (cropQueryForms の形の配列) と同じ作物か (別名を含む) */
function hostMatches(host, forms) {
  if (!host) return false;
  const h = normalize(host);
  return forms.some(f => h === f || cropAliasSet(host).has(f) || cropAliasSet(f).has(h));
}

/** 報告の年 (調査年の終わりの年、無ければ公表年)。並べ替えと「最新の年」に使う */
export function recordYear(r) {
  const m = String(r.year || r.published || "").match(/(\d{4})(?!.*\d{4})/);
  return m ? m[1] : "";
}

/** 海外の報告か (国が日本でない) */
export function isOverseasRecord(r) {
  return !!r.country && r.country !== "日本";
}

function levelRank(level) {
  return (RESISTANCE_LEVELS[level] || { rank: 0 }).rank;
}

/** 並び: この作物での報告 → 同じ成分 → 程度の強い順 → 新しい順 */
function compareHits(a, b) {
  return (b.hostMatch === true) - (a.hostMatch === true)
    || (a.relation === "ingredient" ? 0 : 1) - (b.relation === "ingredient" ? 0 : 1)
    || levelRank(b.record.level) - levelRank(a.record.level)
    || recordYear(b.record).localeCompare(recordYear(a.record));
}

/**
 * 種 taxonIds の報告のうち、成分 ingredient ({name, rac_code}) と同じ成分、または同じ系統のもの。
 * categories は商品の用途 (splitRacCode が印の無いコードを振り分けるのに使う)。
 * crop を渡すと、各報告に hostMatch (報告の宿主作物がその作物か) を付ける。
 * opts.overseas === false なら海外の報告を除く。
 * 戻り値 [{ record, taxon, relation: "ingredient"|"group", code, hostMatch }]
 */
export function findResistance(rx, taxonIds, ingredient, categories, crop, opts = {}) {
  const hits = [];
  const stem = ingredientStem(ingredient.name);
  const split = splitRacCode(ingredient.rac_code, categories || []);
  const forms = crop ? cropQueryForms(normalize(crop)) : null;
  for (const t of taxonIds) {
    const sys = rx.taxa[t] && rx.taxa[t].sys;
    const codes = (sys ? split[sys] : []).filter(c => !RES_NOT_A_GROUP.test(c));
    for (const r of rx.byTaxon.get(t) || []) {
      if (opts.overseas === false && isOverseasRecord(r)) continue;
      const same = !!r.ingredient && ingredientStem(r.ingredient) === stem;
      const code = same ? null : (r.rac || []).find(c => codes.includes(c));
      if (!same && !code) continue;
      hits.push({ record: r, taxon: t, relation: same ? "ingredient" : "group", code: code || null,
                  hostMatch: forms ? hostMatches(r.host, forms) : null });
    }
  }
  return hits.sort(compareHits);
}

/**
 * 種 taxonIds の報告を、系統 (RAC コード) ごとに分ける。抵抗性の画面の表と地図に使う。
 * 系統の分からない報告は "" に入れる。opts は findResistance と同じ。
 * 戻り値 Map(code → [{ record, taxon, hostMatch }])
 */
export function recordsByRacCode(rx, taxonIds, crop, opts = {}) {
  const out = new Map();
  const forms = crop ? cropQueryForms(normalize(crop)) : null;
  for (const t of taxonIds) {
    for (const r of rx.byTaxon.get(t) || []) {
      if (opts.overseas === false && isOverseasRecord(r)) continue;
      const codes = (r.rac || []).filter(c => !RES_NOT_A_GROUP.test(c));
      for (const code of codes.length ? codes : [""]) {
        if (!out.has(code)) out.set(code, []);
        out.get(code).push({ record: r, taxon: t, relation: "group", hostMatch: forms ? hostMatches(r.host, forms) : null });
      }
    }
  }
  for (const list of out.values()) list.sort(compareHits);
  return out;
}

/**
 * 報告の一覧 (findResistance などの戻り値) をまとめる。
 * maxLevel: 最も強い程度 (「検出されず」だけなら not_detected、報告が無ければ null)
 * prefs: 都道府県コードごとの最も強い程度 (Map)、countries: 海外の国の Set、latestYear: 最新の年
 */
export function summarizeResistance(hits) {
  let maxLevel = null;
  let latestYear = "";
  const prefs = new Map();
  const countries = new Set();
  for (const { record: r } of hits) {
    if (!maxLevel || levelRank(r.level) > levelRank(maxLevel)) maxLevel = r.level;
    const y = recordYear(r);
    if (y > latestYear) latestYear = y;
    if (isOverseasRecord(r)) countries.add(r.country);
    else if (r.pref && (!prefs.has(r.pref) || levelRank(r.level) > levelRank(prefs.get(r.pref)))) prefs.set(r.pref, r.level);
  }
  return { count: hits.length, maxLevel, prefs, countries, latestYear };
}

// 都道府県 (JIS コード → 名前、タイル地図の位置 x 列・y 行)。地図は 12 列 × 12 行の格子
export const RES_PREFECTURES = {
  "01": ["北海道", 11, 0], "02": ["青森", 10, 1], "03": ["岩手", 10, 2], "04": ["宮城", 10, 3],
  "05": ["秋田", 9, 2], "06": ["山形", 9, 3], "07": ["福島", 9, 4], "08": ["茨城", 10, 5],
  "09": ["栃木", 9, 5], "10": ["群馬", 8, 5], "11": ["埼玉", 8, 6], "12": ["千葉", 10, 6],
  "13": ["東京", 9, 6], "14": ["神奈川", 9, 7], "15": ["新潟", 8, 4], "16": ["富山", 7, 4],
  "17": ["石川", 6, 4], "18": ["福井", 5, 4], "19": ["山梨", 7, 6], "20": ["長野", 7, 5],
  "21": ["岐阜", 6, 5], "22": ["静岡", 7, 7], "23": ["愛知", 6, 6], "24": ["三重", 5, 6],
  "25": ["滋賀", 5, 5], "26": ["京都", 4, 5], "27": ["大阪", 3, 6], "28": ["兵庫", 3, 5],
  "29": ["奈良", 4, 6], "30": ["和歌山", 4, 7], "31": ["鳥取", 2, 5], "32": ["島根", 1, 5],
  "33": ["岡山", 2, 6], "34": ["広島", 1, 6], "35": ["山口", 0, 6], "36": ["徳島", 3, 8],
  "37": ["香川", 3, 7], "38": ["愛媛", 2, 7], "39": ["高知", 2, 8], "40": ["福岡", 0, 7],
  "41": ["佐賀", 0, 8], "42": ["長崎", 0, 9], "43": ["熊本", 1, 8], "44": ["大分", 1, 7],
  "45": ["宮崎", 1, 9], "46": ["鹿児島", 1, 10], "47": ["沖縄", 0, 11],
};

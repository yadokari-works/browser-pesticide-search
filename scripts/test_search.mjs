#!/usr/bin/env node
/**
 * 検索ロジックを Node で動作確認
 * ブラウザを起動せずに、core モジュールの挙動を検証する
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "src", "data", "pesticides.json");

const { buildIndex, search, detectType } = await import("../src/js/core/search.js");
const { applyFilters, DEFAULT_FILTERS, attachBrandedFlags } = await import("../src/js/core/filter.js");
const { normalize: normalizeMod, expandSearchableCrops, cropGroupMembers, applicationCropMembers, membersHave, searchablePest, splitRacCode } = await import("../src/js/core/normalize.js");

const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));

// 作物・病害虫検索のため applications.json も読み込む
const APPS_PATH = path.join(__dirname, "..", "src", "data", "applications.json");
let applications = {};
if (fs.existsSync(APPS_PATH)) {
  const appsData = JSON.parse(fs.readFileSync(APPS_PATH, "utf-8"));
  applications = appsData.applications || {};
}

const index = buildIndex(db.products, applications);
// app.js の attachCropsPests / attachBrandedFlags 相当 (filter.js が使う派生欄) を付ける
for (const e of index) {
  Object.assign(e.product, {
    _crops_norm: e.norm_crops, _crop_members: e.crop_members, _pests_norm: e.norm_pests, _app_pairs: e.app_entries,
  });
}
attachBrandedFlags(db.products);

console.log(`DB: ${db.products.length} products loaded`);
console.log(`Stats:`, db.stats);
console.log();

const testCases = [
  { query: "イミダクロプリド", expectSomeMatch: true, expectCategory: "殺虫剤" },
  { query: "アドマイヤー", expectSomeMatch: true },
  { query: "4A", expectSomeMatch: true, desc: "IRAC 4A (ネオニコチノイド)" },
  { query: "IRAC 4A", expectSomeMatch: true },
  { query: "M7", expectSomeMatch: true, desc: "FRAC M7" },
  { query: "グリホサート", expectSomeMatch: true, expectCategory: "除草剤" },
  { query: "第12345号", expectSomeMatch: "maybe", desc: "登録番号" },
  { query: "12345", expectSomeMatch: "maybe", desc: "登録番号 (数字のみ)" },
  { query: "バイエル", expectSomeMatch: true, desc: "会社名" },
  { query: "サンヨール", expectSomeMatch: true, desc: "殺虫殺菌剤 (両カテゴリ)" },
  { query: "DDT", expectSomeMatch: true, desc: "失効剤 (type_name)" },
  { query: "BHC", expectSomeMatch: true, desc: "失効剤 (type_name)" },
  { query: "ひ酸鉛", expectSomeMatch: true, desc: "失効剤" },
  { query: "存在しないもの〇△☆", expectSomeMatch: false },
  // 作物・病害虫 + AND 検索
  { query: "なす", expectSomeMatch: true, desc: "作物名" },
  { query: "アブラムシ", expectSomeMatch: true, desc: "病害虫名" },
  { query: "なす アブラムシ", expectSomeMatch: true, desc: "AND: なす × アブラムシ" },
  { query: "イチゴ うどんこ病", expectSomeMatch: true, desc: "AND: イチゴ × うどんこ病" },
  { query: "イミダクロプリド なす", expectSomeMatch: true, desc: "AND: 成分 × 作物" },
  { query: "4A なす", expectSomeMatch: true, desc: "AND: RAC × 作物" },
  { query: "IRAC 4A", expectSomeMatch: true, desc: "IRAC プレフィックスは無視" },
];

let pass = 0, fail = 0;

for (const tc of testCases) {
  const type = detectType(tc.query);
  const results = search(tc.query, index);
  const filtered = applyFilters(results, {
    ...DEFAULT_FILTERS,
    categories: new Set(DEFAULT_FILTERS.categories),
  });

  const hasMatch = filtered.length > 0;
  const ok = tc.expectSomeMatch === "maybe"
    ? true
    : (hasMatch === tc.expectSomeMatch);

  if (ok) pass++; else fail++;

  const mark = ok ? "✓" : "✗";
  const cats = filtered[0] ? (filtered[0].categories || [filtered[0].category]).join("+") : "";
  const statusMark = filtered[0] ? (filtered[0].status === "失効" ? " [失効]" : "") : "";
  const sample = filtered[0]
    ? ` → ${filtered[0].product_name} (${cats})${statusMark}`
    : "";
  console.log(`${mark} [${type}] "${tc.query}" = ${filtered.length} 件${sample}${tc.desc ? ` /* ${tc.desc} */` : ""}`);
}

// ===== AND / OR モード比較テスト =====
// OR は AND の上位集合であり、かつ各トークン単独結果の和集合に一致するはず。
console.log();
console.log("--- AND / OR モード ---");
const baseFilters = () => ({ ...DEFAULT_FILTERS, categories: new Set(DEFAULT_FILTERS.categories) });
const run = (q, mode) => applyFilters(search(q, index, null, mode), baseFilters());
const regSet = (arr) => new Set(arr.map(p => p.reg_no));

const modeCases = [
  { query: "なす アブラムシ", desc: "作物 × 病害虫" },
  { query: "イミダクロプリド グリホサート", desc: "殺虫成分 / 除草成分" },
  { query: "アブラムシ アザミウマ ハダニ", desc: "3 病害虫" },
];

for (const tc of modeCases) {
  const andRes = run(tc.query, "and");
  const orRes = run(tc.query, "or");
  const tokens = tc.query.split(/[\s　]+/).filter(Boolean);
  const union = new Set();
  for (const t of tokens) for (const p of run(t, "and")) union.add(p.reg_no);

  const orIds = regSet(orRes);
  const andIds = regSet(andRes);
  const andSubsetOfOr = [...andIds].every(id => orIds.has(id));
  const orEqualsUnion = orIds.size === union.size && [...orIds].every(id => union.has(id));

  const ok = andSubsetOfOr && orEqualsUnion && orRes.length >= andRes.length;
  if (ok) pass++; else fail++;
  const mark = ok ? "✓" : "✗";
  console.log(
    `${mark} "${tc.query}" AND=${andRes.length} OR=${orRes.length} union=${union.size}` +
    ` /* ${tc.desc}${andSubsetOfOr ? "" : " [AND⊄OR!]"}${orEqualsUnion ? "" : " [OR≠union!]"} */`
  );
}

// ===== 作物×病害虫 共起 (同一適用行) 判定テスト =====
// AND では「ぶどう × うどんこ病」を "ぶどうに対しうどんこ病が登録された適用行" がある
// 商品だけに絞る。ぶどうにはすす点病しか無い商品 (例: 硫黄粉剤系) を拾ってはいけない。
console.log();
console.log("--- 作物×病害虫 共起 (AND) ---");

// 指定商品が、指定作物×病害虫を「同一適用行」に持つか (ground truth 判定。検索コードの照合関数は使わない)。
// - 作物: 作物欄・適用場所 (除外の括弧を取り除いた後) に部分一致、所属作物・別名に完全一致、
//   または病害虫欄の除外でない括弧の中 (例 "うどんこ病(ぶどう)") に部分一致
// - 病害虫: 病害虫欄から "を除く" で終わる括弧を取り除いた文字列に部分一致
// 作物名を病害虫名そのもので照合しない (1.7.2 までの判定は "なし" を "ナシヒメシンクイ" で成立させていた)。
function outerGroups(t) {
  const out = []; let depth = 0, cur = "";
  for (const ch of t) {
    if (ch === "(") { if (depth++ === 0) { if (cur) out.push({ text: cur, paren: false }); cur = ""; continue; } }
    else if (ch === ")" && depth > 0) { if (--depth === 0) { out.push({ text: cur, paren: true }); cur = ""; continue; } }
    cur += ch;
  }
  if (cur) out.push({ text: cur, paren: depth > 0 });
  return out;
}
const isExclusion = g => g.paren && /(除く|のぞく)$/.test(g.text);
const truthPest = a => normalizeMod(outerGroups(String(a.pest || "").normalize("NFKC"))
  .filter(g => !isExclusion(g)).map(g => g.paren ? `(${g.text})` : g.text).join(""));
const truthPestParen = a => normalizeMod(outerGroups(String(a.pest || "").normalize("NFKC"))
  .filter(g => g.paren && !isExclusion(g)).map(g => g.text).join("|"));
const truthCrop = a => [a.crop, a.place].filter(Boolean).flatMap(v => expandSearchableCrops(v)).map(normalizeMod).join("|");
const rowCropOk = (a, cropNorm) => truthCrop(a).includes(cropNorm) ||
  membersHave(applicationCropMembers(a), cropNorm) || truthPestParen(a).includes(cropNorm);
function hasCoOccurrence(product, cropNorm, pestNorm) {
  const entries = applications[String(product.reg_no)] || [];
  return entries.some(a => rowCropOk(a, cropNorm) && truthPest(a).includes(pestNorm));
}

const coCases = [
  { crop: "ぶどう", pest: "うどんこ病" },
  { crop: "なす", pest: "アブラムシ" },
  { crop: "きゅうり", pest: "うどんこ病" },
  { crop: "こまつな", pest: "アブラムシ" },  // 作物群 (非結球あぶらな科葉菜類) の行も含む
];

for (const tc of coCases) {
  const q = `${tc.crop} ${tc.pest}`;
  const res = run(q, "and");
  const cropN = normalizeMod(tc.crop);
  const pestN = normalizeMod(tc.pest);
  // 返ってきた全商品が、同一適用行での共起を実際に持つことを検証
  const violators = res.filter(p => !hasCoOccurrence(p, cropN, pestN));
  const ok = violators.length === 0;
  if (ok) pass++; else fail++;
  const mark = ok ? "✓" : "✗";
  console.log(
    `${mark} "${q}" AND=${res.length} 件` +
    (ok ? " (全件が同一適用行で共起)" : ` /* 共起でない混入 ${violators.length} 件: 例 ${violators[0]?.product_name} */`)
  );
}

// ===== サイドバー 作物×病害虫 フィルタの共起テスト =====
// app.js の attachCropsPests 相当 (_app_pairs / _crops_norm / _pests_norm) を付与し、
// applyFilters に crop+pest を同時指定して同一行共起になっているか検証する。
console.log();
console.log("--- サイドバー 作物×病害虫 フィルタ (共起) ---");

const sidebarCases = [
  { crop: "ぶどう", pest: "うどんこ病" },
  { crop: "なす", pest: "アブラムシ" },
  { crop: "こまつな", pest: "アブラムシ" },
];
for (const tc of sidebarCases) {
  const res = applyFilters(db.products, {
    ...DEFAULT_FILTERS,
    categories: new Set(DEFAULT_FILTERS.categories),
    crop: tc.crop, pest: tc.pest,
  });
  const cropN = normalizeMod(tc.crop), pestN = normalizeMod(tc.pest);
  // 返却全件が「crop欄にcrop かつ 同一行のpest欄 (除外の括弧を除く) にpest」を持つこと
  const violators = res.filter(p =>
    !(applications[String(p.reg_no)] || []).some(a =>
      (truthCrop(a).includes(cropN) || membersHave(applicationCropMembers(a), cropN)) && truthPest(a).includes(pestN))
  );
  const ok = violators.length === 0 && res.length > 0;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "✓" : "✗"} 作物=${tc.crop} 病害虫=${tc.pest} → ${res.length} 件` +
    (violators.length ? ` /* 共起でない混入 ${violators.length} 件 */` : "") +
    (res.length === 0 ? " /* 0件 */" : ""));
}

// ===== サイドバー作物 × 検索語の病害虫 (同一適用行) =====
// 例: 作物=なし、検索 "黒星病 炭疽病" で、なしに黒星病の登録はあるが炭疽病は別作物にしか無い剤
// (商品全体では両方に登録がある) を出してはいけない。正解は検索を使わず全商品から独立に算出する。
console.log();
console.log("--- サイドバー作物 × 検索語の病害虫 (同一適用行) ---");
const scopeFilters = (crop, pest) => ({
  ...DEFAULT_FILTERS,
  categories: new Set(DEFAULT_FILTERS.categories),
  statuses: new Set(["有効"]),
  crop: crop || "", pest: pest || "",
});
// 作物欄だけ / 病害虫欄 (除外の括弧を除く) だけを見て、指定作物の行に pestN があるか (厳密)
const rowHas = (p, cropN, pestN) =>
  (applications[String(p.reg_no)] || []).some(a =>
    (truthCrop(a).includes(cropN) || membersHave(applicationCropMembers(a), cropN)) && truthPest(a).includes(pestN));

const scopeCases = [
  { crop: "なし", pests: ["黒星病", "炭疽病"] },
  { crop: "りんご", pests: ["斑点落葉病", "うどんこ病"] },
  { crop: "きゅうり", pests: ["うどんこ病", "べと病"] },
  { crop: "こまつな", pests: ["アブラムシ", "コナガ"] },
];
for (const tc of scopeCases) {
  for (const mode of ["and", "or"]) {
    const q = tc.pests.join(" ");
    const f = scopeFilters(tc.crop, "");
    const got = applyFilters(search(q, index, null, mode, { crop: tc.crop }), f)
      .map(p => p.reg_no).sort((a, b) => a - b);
    const cropN = normalizeMod(tc.crop);
    const test = p => {
      const hits = tc.pests.map(x => rowHas(p, cropN, normalizeMod(x)));
      return mode === "and" ? hits.every(Boolean) : hits.some(Boolean);
    };
    const truth = applyFilters(db.products, f).filter(test).map(p => p.reg_no).sort((a, b) => a - b);
    const missing = truth.filter(x => !got.includes(x));
    const extra = got.filter(x => !truth.includes(x));
    const ok = truth.length > 0 && missing.length === 0 && extra.length === 0;
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✓" : "✗"} 作物=${tc.crop} 検索="${q}" ${mode.toUpperCase()} → ${got.length} 件 (正解 ${truth.length} 件)` +
      (ok ? "" : ` /* 漏れ ${missing.length} / 余分 ${extra.length} */`));
  }
}

// サイドバーの病害虫 × 検索語の作物 (対称のケース)
{
  const f = scopeFilters("", "うどんこ病");
  const got = applyFilters(search("ぶどう りんご", index, null, "or", { pest: "うどんこ病" }), f)
    .map(p => p.reg_no).sort((a, b) => a - b);
  const pestN = normalizeMod("うどんこ病");
  const truth = applyFilters(db.products, f)
    .filter(p => rowHas(p, normalizeMod("ぶどう"), pestN) || rowHas(p, normalizeMod("りんご"), pestN))
    .map(p => p.reg_no).sort((a, b) => a - b);
  const ok = truth.length > 0 && got.length === truth.length && got.every((x, i) => x === truth[i]);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "✓" : "✗"} 病害虫=うどんこ病 検索="ぶどう りんご" OR → ${got.length} 件 (正解 ${truth.length} 件)`);
}

// ===== 適用表の表示範囲 (指定した作物・病害虫のみ / 剤の登録すべて) =====
console.log();
console.log("--- 適用表の表示範囲 ---");
{
  const { buildRowCondition, hasRowCondition, filterApplications } = await import("../src/js/core/search.js");
  const f = scopeFilters("なし", "");
  const hits = applyFilters(search("黒星病 炭疽病", index, null, "and", { crop: "なし" }), f);
  let allOk = hits.length > 0, narrowedSome = 0;
  for (const p of hits) {
    const apps = applications[String(p.reg_no)] || [];
    const cond = buildRowCondition("黒星病 炭疽病", index.lexicon, "and", { crop: "なし" });
    const rows = filterApplications(apps, cond);
    const cropN = normalizeMod("なし");
    // 絞り込み後の全行が「作物=なし」かつ病害虫が 黒星病 か 炭疽病 であること
    const rowOk = rows.length > 0 && rows.every(a => {
      const crop = [...(a.crop ? expandSearchableCrops(a.crop) : []), ...(a.place ? expandSearchableCrops(a.place) : [])]
        .map(normalizeMod).join("|");
      const pest = normalizeMod(a.pest || "");
      return (crop.includes(cropN) || membersHave(applicationCropMembers(a), cropN)) && (pest.includes(normalizeMod("黒星病")) || pest.includes(normalizeMod("炭疽病")));
    });
    if (!rowOk) allOk = false;
    if (rows.length < apps.length) narrowedSome++;
  }
  if (allOk && narrowedSome > 0) pass++; else fail++;
  console.log(`${allOk && narrowedSome > 0 ? "✓" : "✗"} 作物=なし "黒星病 炭疽病": ${hits.length} 商品すべてで、絞り込み後の行が条件に一致 (行数が減った商品 ${narrowedSome} 件)`);

  // 条件が何も無ければ全登録をそのまま返す (「剤の登録すべて」相当・無指定時)
  const p0 = db.products.find(p => (applications[String(p.reg_no)] || []).length > 3);
  const apps0 = applications[String(p0.reg_no)];
  const noCond = buildRowCondition("", index.lexicon, "and", {});
  const same = !hasRowCondition(noCond) && filterApplications(apps0, noCond) === apps0;
  if (same) pass++; else fail++;
  console.log(`${same ? "✓" : "✗"} 条件なしのとき適用行は絞り込まれない (全 ${apps0.length} 行)`);

  // 商品名・成分名だけの検索語は、行の絞り込み条件にしない
  const nameOnly = buildRowCondition("イミダクロプリド アドマイヤー", index.lexicon, "and", {});
  const noNarrow = !hasRowCondition(nameOnly);
  if (noNarrow) pass++; else fail++;
  console.log(`${noNarrow ? "✓" : "✗"} 成分名・商品名の検索語だけでは適用行を絞らない`);
}

// ===== 作物群 (例 非結球あぶらな科葉菜類) =====
// 作物群で登録された剤は、所属する作物名 (こまつな等) の検索でも出なければならない。
// "を除く" で除外された作物では出してはいけない。所属作物とは完全一致で照合する。
console.log();
console.log("--- 作物群 ---");
{
  const memberCases = [
    { crop: "非結球あぶらな科葉菜類", has: ["こまつな", "チンゲンサイ", "ケール", "ルッコラ", "からしな", "京菜"], not: ["はくさい", "キャベツ"] },
    { crop: "非結球あぶらな科葉菜類(チンゲンサイを除く)", has: ["こまつな"], not: ["チンゲンサイ"] },
    { crop: "非結球あぶらな科葉菜類(なばな類を除く)", has: ["こまつな"], not: ["なばな類", "オータムポエム"] },
    { crop: "豆類(未成熟、ただし、えだまめ、さやいんげんを除く)", has: ["さやえんどう"], not: ["えだまめ", "さやいんげん", "だいず"] },
    { crop: "野菜類(えだまめ、豆類(種実、ただし、らっかせいを除く)、かんしょを除く)", has: ["らっかせい", "トマト"], not: ["だいず", "あずき", "えだまめ", "かんしょ"] },
    { crop: "野菜類(施設栽培、ただし、トマト、ミニトマトを除く)", has: ["なす", "おうぎ"], not: ["トマト", "ミニトマト"] },
    { crop: "かんきつ(温州みかんを除く)", has: ["レモン"], not: ["みかん", "温州みかん"] },
    { crop: "樹木類(まつを除く)", has: ["しらかし"], not: ["あかまつ", "くろまつ"] },
    { crop: "野菜類(とうがらし類を除く)", has: ["なす"], not: ["とうがらし", "甘長とうがらし"] },
    { crop: "うり類(漬物用)", has: [], not: ["メロン", "すいか"] },  // 分類表に無い区分は展開しない
    { crop: "とうもろこし(子実)", has: [], not: ["未成熟とうもろこし"] },
  ];
  for (const tc of memberCases) {
    const s = cropGroupMembers(tc.crop);
    const missing = tc.has.filter(x => !s.has(normalizeMod(x)));
    const extra = tc.not.filter(x => s.has(normalizeMod(x)));
    const ok = missing.length === 0 && extra.length === 0;
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✓" : "✗"} ${tc.crop} → ${s.size} 作物` +
      (missing.length ? ` /* 含まれない: ${missing.join(",")} */` : "") +
      (extra.length ? ` /* 除外されていない: ${extra.join(",")} */` : ""));
  }

  // 適用作物が「非結球あぶらな科葉菜類」そのものの剤は、所属作物の検索で全件出る
  const groupName = normalizeMod("非結球あぶらな科葉菜類");
  const groupProducts = applyFilters(db.products, baseFilters()).filter(p =>
    (applications[String(p.reg_no)] || []).some(a => normalizeMod(a.crop || "") === groupName));
  for (const q of ["こまつな", "チンゲンサイ", "ケール", "ルッコラ", "からしな"]) {
    for (const mode of ["and", "or"]) {
      const got = regSet(run(q, mode));
      const missing = groupProducts.filter(p => !got.has(p.reg_no));
      const ok = groupProducts.length > 0 && missing.length === 0;
      if (ok) pass++; else fail++;
      console.log(`${ok ? "✓" : "✗"} "${q}" ${mode.toUpperCase()} に 非結球あぶらな科葉菜類 登録の ${groupProducts.length} 商品がすべて含まれる` +
        (missing.length ? ` /* 漏れ ${missing.length}: 例 ${missing[0].product_name} */` : ""));
    }
  }

  // 架空の 3 剤で、除外と部分一致を確かめる (実データの剤は別の行で はくさい 等の登録も持つため)
  //   A: 非結球あぶらな科葉菜類 / B: 非結球あぶらな科葉菜類(チンゲンサイを除く) / C: はくさい
  const mk = (reg_no, name) => ({ reg_no, product_name: name, company: "", type_name: name, ingredients: [], categories: ["殺虫剤"] });
  const fakeProducts = [mk(1, "架空A"), mk(2, "架空B"), mk(3, "架空C")];
  const fakeApps = {
    1: [{ crop: "非結球あぶらな科葉菜類", pest: "アブラムシ類" }],
    2: [{ crop: "非結球あぶらな科葉菜類(チンゲンサイを除く)", pest: "アブラムシ類" }],
    3: [{ crop: "はくさい", pest: "アブラムシ類" }],
  };
  const fakeIndex = buildIndex(fakeProducts, fakeApps);
  const names = (q, mode) => search(q, fakeIndex, null, mode).map(p => p.product_name).sort().join(",");
  const fakeCases = [
    { q: "こまつな", want: "架空A,架空B" },
    { q: "チンゲンサイ", want: "架空A" },          // B は除外
    { q: "はくさい", want: "架空C" },              // 所属作物 "非結球はくさい" への部分一致では A/B を出さない
    { q: "非結球はくさい", want: "架空A,架空B" },
    { q: "チンゲンサイ アブラムシ", want: "架空A", modes: ["and"] },  // OR はアブラムシだけで全剤が一致する
  ];
  for (const tc of fakeCases) {
    for (const mode of tc.modes || ["and", "or"]) {
      const got = names(tc.q, mode);
      const ok = got === tc.want;
      if (ok) pass++; else fail++;
      console.log(`${ok ? "✓" : "✗"} 架空データ "${tc.q}" ${mode.toUpperCase()} → ${got || "(なし)"}${ok ? "" : ` /* 期待 ${tc.want} */`}`);
    }
  }

  // 適用表の絞り込みでも、作物群の行が残る
  const { buildRowCondition, filterApplications } = await import("../src/js/core/search.js");
  const cond = buildRowCondition("こまつな", index.lexicon, "and", {});
  const p1 = groupProducts[0];
  const rows = filterApplications(applications[String(p1.reg_no)], cond);
  const okRows = rows.length > 0 && rows.some(a => normalizeMod(a.crop || "") === groupName);
  if (okRows) pass++; else fail++;
  console.log(`${okRows ? "✓" : "✗"} 適用表を "こまつな" で絞ると ${p1.product_name} の 非結球あぶらな科葉菜類 の行が残る (${rows.length} 行)`);
}

// ===== 別名と、病害虫名の頭にも現れる語 =====
// - 別名 (京菜 → みずな) は、作物群の行だけでなく正式名で登録された行にも一致する。
// - 病害虫名の頭にも現れる語 (アザミ → アザミウマ類) は、作物名と一緒に指定したときは病害虫として扱う
//   ("なす アザミ" に、なすのアザミウマ類の登録が無い剤を出さない)。
// 正解は、検索の関数を使わず適用行の文字列と crop_groups.js の表から求める。
console.log();
console.log("--- 別名と、病害虫名の頭にも現れる語 ---");
{
  const { CROP_GROUPS, CROP_ALIASES } = await import("../src/js/core/crop_groups.js");
  // 正規化 (normalize.js と同じ手順をここで書き直したもの)
  const norm = s => String(s || "").normalize("NFKC")
    .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).toUpperCase().replace(/\s+/g, "");

  // 表のデータ: 別名は、どの作物名とも (ひらがな・カタカナの違いを除いて) 重ならない。注記の語は別名にしない
  {
    const memberKeys = new Set(Object.values(CROP_GROUPS).flat().map(norm));
    const clash = Object.entries(CROP_ALIASES).flatMap(([k, ws]) => ws.filter(w => memberKeys.has(norm(w))).map(w => `${k}:${w}`));
    const notes = ["移植", "直播", "肥大茎", "のむかご"].filter(w => Object.values(CROP_ALIASES).flat().includes(w));
    const mukago = (CROP_ALIASES["やまのいも(むかご)"] || []).includes("ジネンジョのむかご");
    const ok = clash.length === 0 && notes.length === 0 && mukago;
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✓" : "✗"} 別名は作物名と重ならず、注記の語を含まない` +
      (clash.length ? ` /* 重なり: ${clash.join(",")} */` : "") + (notes.length ? ` /* 注記: ${notes.join(",")} */` : "") +
      (mukago ? "" : " /* ジネンジョのむかご が無い */"));
  }

  // 別名で検索すると、正式名で直接登録された剤がすべて出る (検索 AND/OR、サイドバーの作物指定)
  const aliasCases = [["京菜", "みずな"], ["さつまいも", "かんしょ"], ["ターサイ", "タアサイ"], ["温州みかん", "みかん"], ["のらぼうな", "なばな類"]];
  for (const [alias, formal] of aliasCases) {
    const okAlias = (CROP_ALIASES[formal] || []).includes(alias);
    const direct = applyFilters(db.products, baseFilters())
      .filter(p => (applications[String(p.reg_no)] || []).some(a => norm(a.crop) === norm(formal)));
    const viaSearch = { and: regSet(run(alias, "and")), or: regSet(run(alias, "or")) };
    const viaSide = regSet(applyFilters(db.products, { ...baseFilters(), crop: alias }));
    const miss = [viaSearch.and, viaSearch.or, viaSide].map(s => direct.filter(p => !s.has(p.reg_no)).length);
    const ok = okAlias && direct.length > 0 && miss.every(x => x === 0);
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✓" : "✗"} 別名 "${alias}" に、作物欄が "${formal}" の ${direct.length} 剤がすべて含まれる` +
      (ok ? "" : ` /* 表の別名 ${okAlias} / 漏れ AND ${miss[0]} OR ${miss[1]} サイドバー ${miss[2]} */`));
  }

  // 作物名 + 病害虫名の頭にも現れる語: 結果は「指定作物の行に、その語を含む病害虫がある剤」と一致する
  // (作物群の行は、表の所属作物に指定作物があれば作物の行とみなす。作物群名と括弧の解釈は表どおりの完全一致だけ見る)
  const groupHas = (field, crop) => {
    const base = String(field || "").normalize("NFKC").replace(/\(.*$/, "");
    return (CROP_GROUPS[base] || []).some(m => norm(m) === norm(crop));
  };
  const cropRowHas = (p, crop, pestWord) => (applications[String(p.reg_no)] || []).some(a =>
    ([a.crop, a.place].some(f => f && norm(f).includes(norm(crop))) || groupHas(a.crop, crop) || groupHas(a.place, crop)) &&
    norm(a.pest).includes(norm(pestWord)));
  const stemCases = [
    { q: "なす アザミ", crop: "なす", word: "アザミ" },
    { q: "きゅうり クロウリ", crop: "きゅうり", word: "クロウリ" },
    { q: "アザミ", scope: "なす", crop: "なす", word: "アザミ" },
    { q: "キクイモ", scope: "とうもろこし", crop: "とうもろこし", word: "キクイモ" },
  ];
  for (const tc of stemCases) {
    for (const mode of tc.scope ? ["and", "or"] : ["and"]) {
      const f = tc.scope ? scopeFilters(tc.scope, "") : baseFilters();
      const got = applyFilters(search(tc.q, index, null, mode, { crop: tc.scope || "" }), f);
      // 余分: 指定作物の行にその語を含む病害虫が無い剤 (作物群の行の除外は見ないため、件数の一致ではなく余分 0 を見る)
      const extra = got.filter(p => !cropRowHas(p, tc.crop, tc.word));
      const ok = extra.length === 0;
      if (ok) pass++; else fail++;
      console.log(`${ok ? "✓" : "✗"} ${tc.scope ? `作物=${tc.scope} ` : ""}"${tc.q}" ${mode.toUpperCase()} → ${got.length} 件、すべて ${tc.crop} の行に ${tc.word}… の病害虫がある` +
        (ok ? "" : ` /* 無関係 ${extra.length} 件: 例 ${extra[0].product_name} */`));
    }
  }

  // 架空データで、語の役割と除外を確かめる
  //   A: 花き類・観葉植物 (所属作物に アザミ) × 灰色かび病  B: なす × アザミウマ類
  //   C: なす × 灰色かび病 と 花き類・観葉植物 × 灰色かび病  D: みずな × アブラムシ類
  //   E: アマランサス(茎葉) × アブラムシ類  F: 稲 × いもち病  G: 直播水稲 × ノビエ
  //   H: なばな類(オータムポエムを除く) × アブラムシ類
  const mk = (reg_no, name) => ({ reg_no, product_name: name, company: "", type_name: name, ingredients: [], categories: ["殺虫剤"] });
  const fakeApps = {
    11: [{ crop: "花き類・観葉植物", pest: "灰色かび病" }],
    12: [{ crop: "なす", pest: "アザミウマ類" }],
    13: [{ crop: "なす", pest: "灰色かび病" }, { crop: "花き類・観葉植物", pest: "灰色かび病" }],
    14: [{ crop: "みずな", pest: "アブラムシ類" }],
    15: [{ crop: "アマランサス(茎葉)", pest: "アブラムシ類" }],
    16: [{ crop: "稲", pest: "いもち病" }],
    17: [{ crop: "直播水稲", pest: "ノビエ" }],
    18: [{ crop: "なばな類(オータムポエムを除く)", pest: "アブラムシ類" }],
  };
  const names = { 11: "A", 12: "B", 13: "C", 14: "D", 15: "E", 16: "F", 17: "G", 18: "H" };
  const fakeIndex = buildIndex(Object.keys(fakeApps).map(k => mk(Number(k), names[k])), fakeApps);
  const got = (q, mode, scope) => search(q, fakeIndex, null, mode, scope).map(p => p.product_name).sort().join(",");
  const cases2 = [
    { q: "アザミ", want: "A,B,C" },                        // 作物の指定が無ければ、作物 (花き類の所属) と病害虫の両方
    { q: "なす アザミ", want: "B", modes: ["and"] },       // 作物と一緒なら病害虫 (C は なす と 花き類 の登録があるだけ)
    { q: "アザミ", want: "B", scope: { crop: "なす" } },    // サイドバーの作物と一緒でも病害虫
    { q: "京菜", want: "D" },                               // 別名は正式名の行にも一致する
    { q: "京菜 アブラムシ", want: "D", modes: ["and"] },
    { q: "はげいとう", want: "A,C" },                       // アマランサス(茎葉) の別名 ハゲイトウ は使わない (花き類の はげいとう と同じ語)
    { q: "直播", want: "G" },                               // 稲の注記 (移植、直播) は別名にしない
    { q: "水稲", want: "F,G" },
    { q: "オータムポエム", want: "" },                      // 除外された別名では一致しない
    { q: "のらぼうな", want: "H" },
  ];
  for (const tc of cases2) {
    for (const mode of tc.modes || ["and", "or"]) {
      const g = got(tc.q, mode, tc.scope);
      const ok = g === tc.want;
      if (ok) pass++; else fail++;
      console.log(`${ok ? "✓" : "✗"} 架空データ ${tc.scope ? `作物=${tc.scope.crop} ` : ""}"${tc.q}" ${mode.toUpperCase()} → ${g || "(なし)"}${ok ? "" : ` /* 期待 ${tc.want || "(なし)"} */`}`);
    }
  }

  // 適用表の絞り込みも同じ規則: "なす アザミ" では なす のアザミウマ類の行だけ、"京菜" では みずな の行が残る
  const { buildRowCondition, filterApplications } = await import("../src/js/core/search.js");
  const rowsOf = (q, reg, scope = {}) => filterApplications(fakeApps[reg], buildRowCondition(q, fakeIndex.lexicon, "and", scope))
    .map(a => `${a.crop}×${a.pest}`).join(",");
  const rowCases = [
    { q: "なす アザミ", reg: 13, want: "" },   // C: なす の行は灰色かび病、花き類の行は作物 なす でない
    { q: "なす アザミ", reg: 12, want: "なす×アザミウマ類" },
    { q: "京菜", reg: 14, want: "みずな×アブラムシ類" },
    { q: "アザミ", reg: 13, want: "花き類・観葉植物×灰色かび病", scope: { crop: "" } },
  ];
  for (const tc of rowCases) {
    const g = rowsOf(tc.q, tc.reg, tc.scope);
    const ok = g === tc.want;
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✓" : "✗"} 適用表 "${tc.q}" ${names[tc.reg]} → ${g || "(行なし)"}${ok ? "" : ` /* 期待 ${tc.want || "(行なし)"} */`}`);
  }
}

// ===== 括弧が並ぶ作物名 =====
// "うり類(漬物用)(しろうり、とうがんを除く)" のように括弧が並んでも、除外の括弧は取り除き、
// 除外された作物 (しろうり) の検索に一致させない。除外の括弧が前にある場合 (きのこ類) も同じ。
console.log();
console.log("--- 括弧が並ぶ作物名 ---");
{
  const expandCases = [
    ["うり類(漬物用)(しろうり、とうがんを除く)", "うり類(漬物用)"],
    ["きのこ類(えのきたけ、しいたけ、なめこ、ひらたけを除く)(菌床栽培)", "きのこ類(菌床栽培)"],
    ["西洋芝(ベントグラス)(生産圃場)", "西洋芝(ベントグラス)(生産圃場)"],
    ["豆類(種実)(施設栽培)", "豆類(種実)(施設栽培)"],
    ["てんさい(ALS阻害剤耐性)(移植栽培)", "てんさい(ALS阻害剤耐性)(移植栽培)"],
  ];
  for (const [crop, want] of expandCases) {
    const g = expandSearchableCrops(crop).map(c => c.normalize("NFKC")).join(",");
    const ok = g === want;
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✓" : "✗"} ${crop} → ${g}${ok ? "" : ` /* 期待 ${want} */`}`);
  }

  // 実データの適用表: 除外された作物で絞ったとき、その行は残らない
  const { buildRowCondition, filterApplications } = await import("../src/js/core/search.js");
  const rowCases = [
    { reg: "18500", q: "しろうり", crop: "うり類(漬物用)(しろうり、とうがんを除く)" },  // カスケード乳剤
    { reg: "21075", q: "しいたけ", crop: "きのこ類(えのきたけ、しいたけ、なめこ、ひらたけを除く)(菌床栽培)" },  // きのこ用ベンレート水和剤
  ];
  for (const tc of rowCases) {
    const apps = applications[tc.reg] || [];
    const present = apps.some(a => (a.crop || "").normalize("NFKC") === tc.crop);
    if (!present) {
      // FAMIC 側の正当な登録変更で週次更新が止まらないよう、失敗にしない (同じ内容は下の架空データで確かめる)
      console.log(`⚠ 第${tc.reg}号に「${tc.crop}」の行が無いため、実データでの確認を飛ばした`);
      continue;
    }
    const rows = filterApplications(apps, buildRowCondition(tc.q, index.lexicon, "and", {}));
    const leaked = rows.some(a => (a.crop || "").normalize("NFKC") === tc.crop);
    const ok = !leaked;
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✓" : "✗"} 適用表を "${tc.q}" で絞ると「${tc.crop}」の行は残らない`);
  }

  // 同じ内容を架空データで (実データの変更に左右されない)
  const mk = (reg_no, name) => ({ reg_no, product_name: name, company: "", type_name: name, ingredients: [], categories: ["殺菌剤"] });
  // 33・34 は、しろうり・しいたけ を作物の語として語彙に入れるための剤 (実データでは他の剤の登録がある)
  const fakeApps = {
    31: [{ crop: "うり類(漬物用)(しろうり、とうがんを除く)", pest: "うどんこ病" }],
    32: [{ crop: "きのこ類(えのきたけ、しいたけ、なめこ、ひらたけを除く)(菌床栽培)", pest: "トリコデルマ菌" }],
    33: [{ crop: "しろうり", pest: "べと病" }],
    34: [{ crop: "しいたけ", pest: "害菌" }],
  };
  const fakeIndex = buildIndex([mk(31, "架空うり"), mk(32, "架空きのこ"), mk(33, "架空しろうり"), mk(34, "架空しいたけ")], fakeApps);
  const fakeCases = [
    { q: "しろうり", reg: 31, want: false },
    { q: "うり類", reg: 31, want: true },
    { q: "しいたけ", reg: 32, want: false },
    { q: "ぶなしめじ", reg: 32, want: true },   // 菌床栽培は栽培条件なので、きのこ類の所属作物で引ける
    { q: "まいたけ トリコデルマ菌", reg: 32, want: true },
  ];
  for (const tc of fakeCases) {
    const hit = search(tc.q, fakeIndex, null, "and", {}).some(p => p.reg_no === tc.reg);
    const rows = filterApplications(fakeApps[tc.reg], buildRowCondition(tc.q, fakeIndex.lexicon, "and", {}));
    const ok = hit === tc.want && (rows.length > 0) === tc.want;
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✓" : "✗"} 架空データ "${tc.q}" → ${hit ? "一致" : "不一致"}、適用表 ${rows.length} 行${ok ? "" : ` /* 期待 ${tc.want ? "一致" : "不一致"} */`}`);
  }
}

// ===== 2026-10-18 の 3AI レビューで再現した誤り =====
console.log();
console.log("--- レビュー指摘 (2026-10-18) ---");
{
  const check = (ok, label) => { if (ok) pass++; else fail++; console.log(`${ok ? "✓" : "✗"} ${label}`); };
  const names = list => list.slice(0, 3).map(p => p.product_name).join(", ");

  // 作物×病害虫: 作物の語が商品名・成分名・別の行の病害虫名で成立しない
  //   ばら → 商品名 バラライカ、くり → 成分 アクリナトリン、らん → 商品名 オルトラン、
  //   なし → びわ×ナシヒメシンクイ、なす → 宿根アスター×ヨメナスジハモグリバエ、キャベツ カメムシ → 成分 ナミヒメハナカメムシ
  for (const [crop, pest] of [["なし", "シンクイ"], ["くり", "アブラムシ"], ["ばら", "うどんこ病"], ["らん", "アブラムシ"],
    ["もも", "アブラムシ"], ["なす", "ハモグリバエ"], ["キャベツ", "カメムシ"], ["移植水稲", "イネ科雑草"]]) {
    const res = run(`${crop} ${pest}`, "and");
    const bad = res.filter(p => !hasCoOccurrence(p, normalizeMod(crop), normalizeMod(pest)));
    check(bad.length === 0, `"${crop} ${pest}" AND=${res.length} 件` + (bad.length ? ` /* 同一行でない ${bad.length} 件: ${names(bad)} */` : " (全件が同一行で共起)"));
  }

  // 1 語の作物名: 作物欄に無い剤 (病害虫名にだけ語がある剤) を出さない。AND と OR は同じ結果
  for (const crop of ["なし", "もも", "トマト"]) {
    const cn = normalizeMod(crop);
    const productLevel = p => [p.product_name, p.company, p.type_name, ...p.ingredients.map(i => i.name)].some(v => normalizeMod(v).includes(cn));
    const and = run(crop, "and"), or = run(crop, "or");
    const bad = and.filter(p => !productLevel(p) && !(applications[String(p.reg_no)] || []).some(a => rowCropOk(a, cn)));
    const same = and.length === or.length;
    check(bad.length === 0 && same, `"${crop}" → ${and.length} 件、作物欄に無い剤 ${bad.length} 件、AND と OR ${same ? "同じ" : "が違う"}` + (bad.length ? ` /* ${names(bad)} */` : ""));
  }

  // 病害虫欄の "(…を除く)": 除外された雑草では一致しない
  for (const [q, notIn] of [["スズメノカタビラ", "ナブ乳剤"], ["カヤツリグサ", "トレファノサイド乳剤"]]) {
    const res = run(q, "and");
    const qn = normalizeMod(q);
    const bad = res.filter(p => !(applications[String(p.reg_no)] || []).some(a => truthPest(a).includes(qn) || rowCropOk(a, qn)) &&
      ![p.product_name, p.type_name, ...p.ingredients.map(i => i.name)].some(v => normalizeMod(v).includes(qn)));
    check(bad.length === 0 && !res.some(p => p.product_name === notIn),
      `"${q}" → ${res.length} 件、除外の行だけで一致した剤 ${bad.length} 件、${notIn} ${res.some(p => p.product_name === notIn) ? "が出る" : "は出ない"}`);
  }
  const sp = [
    ["一年生イネ科雑草(スズメノカタビラを除く)", "一年生イネ科雑草"],
    ["一年生雑草(ツユクサ科、カヤツリグサ科、キク科、アブラナ科を除く)", "一年生雑草"],
    ["ミズガヤツリ(北海道を除く)", "ミズガヤツリ"],
    ["苗立枯病(ピシウム菌)", "苗立枯病(ピシウム菌)"],
    ["アオミドロ・藻類による表層はく離(北陸を除く)", "アオミドロ・藻類による表層はく離"],
  ];
  for (const [pest, want] of sp) {
    const g = searchablePest(pest);
    check(g === want, `searchablePest("${pest}") → "${g}"` + (g === want ? "" : ` /* 期待 "${want}" */`));
  }

  // RAC コード: "1" は 1A・1B に当たり、11・14 などには当たらない (検索結果の全件に、その系統の該当コードがある)
  const racOk = (c, q) => c === q || (c.startsWith(q) && !/[0-9]/.test(c.charAt(q.length)));
  for (const [sysWord, sys, code] of [["FRAC", "F", "1"], ["IRAC", "I", "1"], ["IRAC", "I", "2"], ["IRAC", "I", "3"], ["HRAC", "H", "1"], ["FRAC", "F", "4"], ["FRAC", "F", "16"]]) {
    const res = run(`${sysWord} ${code}`, "and");
    const bad = res.filter(p => !p.ingredients.some(i =>
      splitRacCode(i.rac_code, p.categories || [p.category])[sys].some(c => racOk(c.toUpperCase(), code))));
    check(res.length > 0 && bad.length === 0, `"${sysWord} ${code}" → ${res.length} 件、該当コードの無い剤 ${bad.length} 件` + (bad.length ? ` /* ${names(bad)} */` : ""));
  }
  // 殺虫殺菌剤の成分の系統: タネサンGT (ダイアジノン 1B、チウラム M3) は IRAC 1B と FRAC M3 にだけ出る
  const tane = db.products.find(p => p.product_name === "タネサンGT" && p.status !== "失効");
  if (tane) {
    const inQ = q => search(q, index, null, "and").includes(tane);
    const got = ["IRAC 1B", "FRAC M3", "IRAC M3", "FRAC 1B"].map(inQ);
    check(got.join() === "true,true,false,false", `タネサンGT: IRAC 1B ${got[0]} / FRAC M3 ${got[1]} / IRAC M3 ${got[2]} / FRAC 1B ${got[3]}`);
  } else {
    console.log("⚠ タネサンGT が現行剤に無いため、RAC 系統の確認を飛ばした");
  }
  // 系統を明示した英字のコードと全角入力
  const n1 = run("IRAC UN", "and").length, n2 = run("IRACUN", "and").length;
  check(n1 > 0 && n1 === n2, `"IRAC UN" ${n1} 件 = "IRACUN" ${n2} 件`);
  const w1 = run("ＩＲＡＣ ４Ａ", "and").length, w2 = run("IRAC 4A", "and").length;
  check(w1 > 0 && w1 === w2, `"ＩＲＡＣ ４Ａ" ${w1} 件 = "IRAC 4A" ${w2} 件`);
  // ラジオで系統を選んでいても、数字を含む商品名で引ける。系統を明示入力したときは RAC コードだけで判定する
  const radio = applyFilters(search("アミスター 20", index, "F", "and"), baseFilters()).length;
  const explicit = run("FRAC 20 アミスター", "and").length;
  check(radio > 0 && explicit === 0, `FRAC を選んだまま "アミスター 20" → ${radio} 件 / "FRAC 20 アミスター" → ${explicit} 件`);

  // 屋号付きを除外: 同じグループの屋号の無い商品が結果に無いときは表示する
  const yashi = run("ヤシ類 タイワンカブトムシ", "and");
  if ((applications[String((db.products.find(p => p.product_name === "サンケイダイアジノン粒剤5") || {}).reg_no)] || []).length) {
    check(yashi.some(p => p.product_name === "サンケイダイアジノン粒剤5"), `"ヤシ類 タイワンカブトムシ" (屋号付きを除外) → ${yashi.length} 件: ${names(yashi)}`);
  } else {
    console.log("⚠ サンケイダイアジノン粒剤5 の適用が無いため、実データでの確認を飛ばした");
  }
  {
    const mk = (reg_no, name, branded) => ({ reg_no, product_name: name, company: "", type_name: "架空粒剤", ingredients: [{ name: "架空成分", density: "5%" }], categories: ["殺虫剤"] });
    const fp = [mk(41, "架空粒剤5"), mk(42, "サンケイ架空粒剤5")];
    const fa = { 41: [{ crop: "なす", pest: "アブラムシ類" }], 42: [{ crop: "なす", pest: "アブラムシ類" }, { crop: "ヤシ類", pest: "タイワンカブトムシ" }] };
    const fi = buildIndex(fp, fa);
    for (const e of fi) Object.assign(e.product, { _app_pairs: e.app_entries, _crops_norm: e.norm_crops, _crop_members: e.crop_members, _pests_norm: e.norm_pests });
    attachBrandedFlags(fp);
    const f = { ...DEFAULT_FILTERS, categories: new Set(DEFAULT_FILTERS.categories) };
    const g = q => applyFilters(search(q, fi, null, "and"), f).map(p => p.product_name).join(",");
    check(g("なす アブラムシ") === "架空粒剤5" && g("ヤシ類 タイワンカブトムシ") === "サンケイ架空粒剤5",
      `架空データ 屋号付き: "なす アブラムシ" → ${g("なす アブラムシ")} / "ヤシ類 タイワンカブトムシ" → ${g("ヤシ類 タイワンカブトムシ")}`);
  }
}

console.log();
console.log(`Result: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);

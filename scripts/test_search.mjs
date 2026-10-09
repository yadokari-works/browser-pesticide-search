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
const { applyFilters, DEFAULT_FILTERS } = await import("../src/js/core/filter.js");
const { normalize: normalizeMod, expandSearchableCrops } = await import("../src/js/core/normalize.js");

const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));

// 作物・病害虫検索のため applications.json も読み込む
const APPS_PATH = path.join(__dirname, "..", "src", "data", "applications.json");
let applications = {};
if (fs.existsSync(APPS_PATH)) {
  const appsData = JSON.parse(fs.readFileSync(APPS_PATH, "utf-8"));
  applications = appsData.applications || {};
}

const index = buildIndex(db.products, applications);

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

// 指定商品が、指定作物×病害虫を「同一適用行」に持つか (ground truth 判定)。
// 作物名が病害虫欄の括弧内 (例 "うどんこ病(ぶどう)") にある場合も共起とみなすため、
// 各行の crop/place/pest を結合したテキストで両語の有無を見る。
function hasCoOccurrence(product, cropNorm, pestNorm) {
  const entries = applications[String(product.reg_no)] || [];
  return entries.some(a => {
    const parts = [];
    if (a.crop) parts.push(...expandSearchableCrops(a.crop));
    if (a.place) parts.push(...expandSearchableCrops(a.place));
    if (a.pest) parts.push(a.pest);
    const text = parts.map(normalizeMod).join("|");
    return text.includes(cropNorm) && text.includes(pestNorm);
  });
}

const coCases = [
  { crop: "ぶどう", pest: "うどんこ病" },
  { crop: "なす", pest: "アブラムシ" },
  { crop: "きゅうり", pest: "うどんこ病" },
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
for (const p of db.products) {
  const entries = applications[String(p.reg_no)] || [];
  const crops = new Set(), pests = new Set(), pairs = [];
  for (const a of entries) {
    const cparts = [];
    if (a.crop) for (const c of expandSearchableCrops(a.crop)) { const n = normalizeMod(c); crops.add(n); cparts.push(n); }
    if (a.place) for (const c of expandSearchableCrops(a.place)) { const n = normalizeMod(c); crops.add(n); cparts.push(n); }
    const pn = a.pest ? normalizeMod(a.pest) : "";
    if (pn) pests.add(pn);
    pairs.push({ crop: cparts.join("|"), pest: pn });
  }
  p._crops_norm = [...crops].join("|");
  p._pests_norm = [...pests].join("|");
  p._app_pairs = pairs;
}

const sidebarCases = [
  { crop: "ぶどう", pest: "うどんこ病" },
  { crop: "なす", pest: "アブラムシ" },
];
for (const tc of sidebarCases) {
  const res = applyFilters(db.products, {
    ...DEFAULT_FILTERS,
    categories: new Set(DEFAULT_FILTERS.categories),
    crop: tc.crop, pest: tc.pest,
  });
  const cropN = normalizeMod(tc.crop), pestN = normalizeMod(tc.pest);
  // 返却全件が「crop欄にcrop かつ 同一行のpest欄にpest」を持つこと
  const violators = res.filter(p =>
    !(p._app_pairs || []).some(e => e.crop.includes(cropN) && e.pest.includes(pestN))
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
// 作物欄だけ / 病害虫欄だけを見て、指定作物の行に pestN があるか (厳密)
const rowHas = (p, cropN, pestN) =>
  (p._app_pairs || []).some(e => e.crop.includes(cropN) && e.pest.includes(pestN));

const scopeCases = [
  { crop: "なし", pests: ["黒星病", "炭疽病"] },
  { crop: "りんご", pests: ["斑点落葉病", "うどんこ病"] },
  { crop: "きゅうり", pests: ["うどんこ病", "べと病"] },
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
      return crop.includes(cropN) && (pest.includes(normalizeMod("黒星病")) || pest.includes(normalizeMod("炭疽病")));
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

console.log();
console.log(`Result: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);

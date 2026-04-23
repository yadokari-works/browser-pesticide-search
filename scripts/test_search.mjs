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

console.log();
console.log(`Result: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);

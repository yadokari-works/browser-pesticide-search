#!/usr/bin/env node
/**
 * 抵抗性・耐性の照合 (src/js/core/resistance.js) の回帰テスト。1 件でも失敗で exit 1。
 * 照合の規則は、固定の小さな試験データ (このファイルの FIXTURE) で確かめる。実データ (src/data/resistance.json) は
 * 件数が利用者の確認に応じて変わるので、形の整合 (種 ID の参照切れなど) だけを確かめる。
 * 使い方: node scripts/test_resistance.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  buildResistanceIndex, resolveTaxa, findResistance, recordsByRacCode, summarizeResistance,
  ingredientStem, recordYear, pestNamesForTaxa, RES_PREFECTURES,
} = await import("../src/js/core/resistance.js");

// 試験用のデータ。学名・成分・程度は照合の規則を確かめるための仮の組み合わせで、実際の報告ではない
const rec = (id, taxon, host, pref, ingredient, rac, level, year, extra = {}) => ({
  id, taxon, host, pref, ingredient, rac, level, year, country: "日本", origin: "domestic",
  evidence: "生物検定", src: { url: "https://example.invalid/", accessed: "2026-10-22" }, ...extra,
});
const FIXTURE = {
  schema_version: 1,
  taxa: {
    podosphaera_xanthii: { sci: "Podosphaera xanthii", ja: "", kind: "糸状菌", sys: "F", syn: [] },
    pseudoidium_neolycopersici: { sci: "Pseudoidium neolycopersici", ja: "", kind: "糸状菌", sys: "F", syn: [] },
    leveillula_taurica: { sci: "Leveillula taurica", ja: "", kind: "糸状菌", sys: "F", syn: [] },
    botrytis_cinerea: { sci: "Botrytis cinerea", ja: "", kind: "糸状菌", sys: "F", syn: [] },
    tetranychus_urticae: { sci: "Tetranychus urticae", ja: "ナミハダニ", kind: "ダニ", sys: "I", syn: [] },
    aphis_gossypii: { sci: "Aphis gossypii", ja: "ワタアブラムシ", kind: "昆虫", sys: "I", syn: [] },
    myzus_persicae: { sci: "Myzus persicae", ja: "モモアカアブラムシ", kind: "昆虫", sys: "I", syn: [] },
  },
  pest_map: [
    { pest: "うどんこ病", crop: "きゅうり", taxa: ["podosphaera_xanthii"] },
    { pest: "うどんこ病", crop: "トマト", taxa: ["pseudoidium_neolycopersici", "leveillula_taurica"] },
    { pest: "灰色かび病", crop: "*", taxa: ["botrytis_cinerea"] },
    { pest: "アブラムシ類", crop: "なす", taxa: ["aphis_gossypii", "myzus_persicae"] },
    { pest: "アブラムシ類", crop: "うり類", taxa: ["aphis_gossypii"] },
  ],
  records: [
    rec("r1", "podosphaera_xanthii", "きゅうり", "08", "アゾキシストロビン", ["11"], "resistant", "2020"),
    rec("r2", "botrytis_cinerea", "いちご", "09", "ボスカリド", ["7"], "reduced", "2018"),
    rec("r3", "botrytis_cinerea", "トマト", "08", "ボスカリド", ["7"], "not_detected", "2022"),
    rec("r4", "tetranychus_urticae", "いちご", "22", "シフルメトフェン", ["25A"], "field_failure", "2019-2020"),
    rec("r5", "aphis_gossypii", "きゅうり", "", "イミダクロプリド", ["4A"], "resistant", "2015",
        { country: "Australia", origin: "aprd" }),
    rec("r6", "aphis_gossypii", "きゅうり", "12", "某成分", ["UN"], "resistant", "2021"),
    rec("r7", "botrytis_cinerea", "いちご", "08", "ボスカリド", ["7"], "field_failure", "2021"),
  ],
  sources: [{ id: "aprd", name: "APRD", url: "", region: "海外" }],
};

let pass = 0, fail = 0;
function check(ok, label, detail = "") {
  if (ok) { pass++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}${detail ? ` (${detail})` : ""}`); }
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const rx = buildResistanceIndex(FIXTURE);

// --- 種を決める: 同じ病名でも作物で病原菌が違う ---
let t = resolveTaxa(rx, "きゅうり", "うどんこ病");
check(same(t.taxa, ["podosphaera_xanthii"]) && t.basis === "crop", "きゅうり × うどんこ病 → Podosphaera xanthii", JSON.stringify(t));
t = resolveTaxa(rx, "トマト", "うどんこ病");
check(same(t.taxa, ["pseudoidium_neolycopersici", "leveillula_taurica"]), "トマト × うどんこ病 → 2 種", JSON.stringify(t.taxa));
t = resolveTaxa(rx, null, "うどんこ病");
check(t.taxa.length === 0 && t.basis === null && t.cropSpecific, "作物の指定が無いうどんこ病 → 決めない (作物ごとの対応しか無い)", JSON.stringify(t));
t = resolveTaxa(rx, "野菜類", "うどんこ病");
check(t.taxa.length === 0 && t.cropSpecific, "作物群「野菜類」× うどんこ病 → 決めない", JSON.stringify(t));
t = resolveTaxa(rx, "なす", "灰色かび病");
check(same(t.taxa, ["botrytis_cinerea"]) && t.basis === "any", "なす × 灰色かび病 → 全作物の対応 (*) で Botrytis cinerea");
t = resolveTaxa(rx, null, "灰色かび病");
check(same(t.taxa, ["botrytis_cinerea"]), "作物の指定が無い灰色かび病 → 全作物の対応で決まる");
t = resolveTaxa(rx, "にがうり", "アブラムシ類");
check(same(t.taxa, ["aphis_gossypii"]) && t.basis === "group", "にがうり × アブラムシ類 → 作物群「うり類」の対応", JSON.stringify(t));
t = resolveTaxa(rx, "なす", "アブラムシ類");
check(same(t.taxa, ["aphis_gossypii", "myzus_persicae"]) && t.basis === "crop", "なす × アブラムシ類 → 作物ごとの対応 (作物群より優先)");
t = resolveTaxa(rx, "ナス", "アブラムシ類");
check(t.basis === "crop", "作物名はかな・カナを問わない (ナス)");
t = resolveTaxa(rx, "いちご", "ナミハダニ");
check(same(t.taxa, ["tetranychus_urticae"]) && t.basis === "name", "病害虫名が種の和名と同じ (ナミハダニ) → その種");
t = resolveTaxa(rx, "いちご", "ハスモンヨトウ");
check(t.taxa.length === 0 && t.basis === null, "対応の無い病害虫名 → 未登録 (推測しない)");

// --- 同じ種に当たる病害虫名 (登録を数えるとき、群名の登録も含める) ---
const names = ["アブラムシ類", "ワタアブラムシ", "モモアカアブラムシ", "ハスモンヨトウ", "うどんこ病"];
check(same(pestNamesForTaxa(rx, "なす", names, ["aphis_gossypii"]), ["アブラムシ類", "ワタアブラムシ"]),
  "なす × ワタアブラムシ → 対応で含むとした「アブラムシ類」の登録も数える");
check(same(pestNamesForTaxa(rx, "いちご", names, ["aphis_gossypii"]), ["ワタアブラムシ"]),
  "対応の無い作物 (いちご) では群名「アブラムシ類」を含めない");

// --- 報告を引く: 同じ成分と同じ系統を分ける ---
const fung = ["殺菌剤"], ins = ["殺虫剤"];
let h = findResistance(rx, ["podosphaera_xanthii"], { name: "アゾキシストロビン", rac_code: "11" }, fung, "きゅうり");
check(h.length === 1 && h[0].relation === "ingredient" && h[0].hostMatch === true, "同じ成分 → relation ingredient、宿主作物が一致", JSON.stringify(h));
h = findResistance(rx, ["podosphaera_xanthii"], { name: "ピラクロストロビン", rac_code: "11" }, fung, "きゅうり");
check(h.length === 1 && h[0].relation === "group" && h[0].code === "11", "同じ系統 (FRAC 11) の別成分 → relation group");
h = findResistance(rx, ["podosphaera_xanthii"], { name: "フルジオキソニル", rac_code: "12" }, fung, "きゅうり");
check(h.length === 0, "系統の違う成分 → 報告なし");
h = findResistance(rx, ["podosphaera_xanthii"], { name: "アゾキシストロビン", rac_code: "11" }, ins, "きゅうり");
check(h.length === 1 && h[0].relation === "ingredient", "用途が違っても成分が同じなら当たる");
h = findResistance(rx, ["podosphaera_xanthii"], { name: "某剤", rac_code: "UN(I*), 11(F*)" }, ["殺虫剤", "殺菌剤"], null);
check(h.length === 1 && h[0].code === "11", "印付きの複合コードは系統 (FRAC) のコードで照合", JSON.stringify(h));
h = findResistance(rx, ["aphis_gossypii"], { name: "別成分", rac_code: "UN" }, ins, "きゅうり");
check(!h.some(x => x.record.id === "r6"), "UN (作用機構不明) は同じ系統として扱わない");
h = findResistance(rx, ["aphis_gossypii"], { name: "クロチアニジン", rac_code: "4A" }, ins, "きゅうり");
check(h.length === 1 && h[0].record.id === "r5", "海外の報告も既定では含める");
h = findResistance(rx, ["aphis_gossypii"], { name: "クロチアニジン", rac_code: "4A" }, ins, "きゅうり", { overseas: false });
check(h.length === 0, "overseas: false で海外の報告を除く");
h = findResistance(rx, ["botrytis_cinerea"], { name: "ボスカリド", rac_code: "7" }, fung, "トマト");
check(h.length === 3 && h[0].record.id === "r3" && h[0].hostMatch === true && h.slice(1).every(x => x.hostMatch === false),
  "宿主作物の一致する報告を先に並べる", h.map(x => x.record.id).join(","));
h = findResistance(rx, ["botrytis_cinerea"], { name: "ボスカリド", rac_code: "7" }, fung, "いちご");
check(h.map(x => x.record.id).join(",") === "r7,r2,r3", "同じ作物の中では程度の強い順 (効果低下 → 感受性低下)", h.map(x => x.record.id).join(","));
h = findResistance(rx, ["botrytis_cinerea"], { name: "ボスカリド", rac_code: "7" }, fung, "オランダイチゴ");
check(h[0].hostMatch === true, "宿主作物は別名 (オランダイチゴ = いちご) でも一致");

check(ingredientStem("グリホサートカリウム塩") === ingredientStem("グリホサート"), "成分名の塩の語尾を除いて照合");
check(ingredientStem("イミノクタジン酢酸塩") === ingredientStem("イミノクタジン"), "酢酸塩の語尾を除いて照合");
check(recordYear({ year: "2019-2020" }) === "2020" && recordYear({ published: "2025-02-10" }) === "2025", "年は調査年の終わり、無ければ公表年");

// --- まとめ ---
let s = summarizeResistance(findResistance(rx, ["botrytis_cinerea"], { name: "ボスカリド", rac_code: "7" }, fung, null));
check(s.count === 3 && s.maxLevel === "field_failure" && s.prefs.get("08") === "field_failure" && s.prefs.get("09") === "reduced"
  && s.latestYear === "2022", "まとめ: 最も強い程度、県ごとの最も強い程度、最新の年", JSON.stringify({ ...s, prefs: [...s.prefs] }));
s = summarizeResistance(findResistance(rx, ["aphis_gossypii"], { name: "クロチアニジン", rac_code: "4A" }, ins, null));
check(s.countries.has("Australia") && s.prefs.size === 0, "まとめ: 海外の報告は国で数え、県に入れない");
s = summarizeResistance([]);
check(s.count === 0 && s.maxLevel === null, "報告が無ければ maxLevel は null");

const byCode = recordsByRacCode(rx, ["botrytis_cinerea", "aphis_gossypii"], "いちご");
check(byCode.get("7").length === 3 && byCode.get("4A").length === 1 && !byCode.has("UN") && byCode.get("").length === 1,
  "系統ごとに分ける (UN は系統の分からない報告として扱う)", JSON.stringify([...byCode.keys()]));

// --- 都道府県のタイル地図 ---
// "10"〜"47" は配列の添字の形なので Object.keys では "01"〜"09" より先に並ぶ。並べ替えてから比べる
const codes = Object.keys(RES_PREFECTURES).sort();
const cells = new Set(Object.values(RES_PREFECTURES).map(([, x, y]) => `${x},${y}`));
check(codes.length === 47 && codes.every((c, i) => c === String(i + 1).padStart(2, "0")), "都道府県は 01〜47 の 47 件");
check(cells.size === 47, "タイル地図の位置が重ならない");

// --- 実データの形 ---
const real = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/resistance.json"), "utf-8"));
const realRx = buildResistanceIndex(real);
check(real.records.every(r => real.taxa[r.taxon]), "実データ: 報告の種 ID がすべて taxa にある");
check(real.pest_map.every(e => e.taxa.every(id => real.taxa[id])), "実データ: 病害虫名の対応の種 ID がすべて taxa にある");
check(real.records.every(r => r.src && r.src.url && r.src.accessed), "実データ: 報告すべてに出典の URL と閲覧日がある");
check(Object.values(real.taxa).every(x => ["I", "F", "H"].includes(x.sys)), "実データ: 種すべてに系統 (I/F/H) がある");
check(realRx.recordCount === real.records.length, `実データ: 索引を作れる (報告 ${real.records.length} 件)`);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

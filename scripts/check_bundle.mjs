#!/usr/bin/env node
/**
 * 配布物 (build/これをクリック.html と docs/index.html) の検査。
 * test_search.mjs は src のモジュールを直接読むため、正規表現で import/export を除いて 1 つにまとめた
 * 配布 HTML そのものは確かめていない。ここで次を確かめ、1 つでも外れたら終了コード 1 にする。
 *   - インラインの script がすべて JavaScript として構文エラーにならない
 *   - 埋め込んだデータ (window.PESTICIDES_DB / window.APPLICATIONS) が src/data の JSON と同じ
 *   - VERSION の版がページに書かれている
 * 使い方: node scripts/check_bundle.mjs
 */
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["build/これをクリック.html", "docs/index.html"];
const version = fs.readFileSync(path.join(ROOT, "VERSION"), "utf-8").trim();
const srcMain = fs.readFileSync(path.join(ROOT, "src/data/pesticides.json"), "utf-8");
const srcApps = fs.readFileSync(path.join(ROOT, "src/data/applications.json"), "utf-8");

let fail = 0;
const check = (ok, label) => { console.log(`${ok ? "✓" : "✗"} ${label}`); if (!ok) fail++; };

for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { check(false, `${rel} が無い`); continue; }
  const html = fs.readFileSync(file, "utf-8");
  const scripts = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter(m => !/\bsrc\s*=/.test(m[1] || ""))
    .map(m => m[2]);
  let syntaxOk = true;
  for (const [i, code] of scripts.entries()) {
    try { new vm.Script(code, { filename: `${rel}#script${i}` }); }
    catch (e) { syntaxOk = false; console.log(`  ${rel} の ${i} 番目の script: ${e.message}`); }
  }
  check(scripts.length > 0 && syntaxOk, `${rel}: インラインの script ${scripts.length} 個の構文`);

  const dataScript = scripts.find(c => c.includes("window.PESTICIDES_DB ="));
  if (!dataScript) { check(false, `${rel}: データの script が無い`); continue; }
  const sandbox = { window: {} };
  vm.runInNewContext(dataScript, sandbox);
  const sameMain = JSON.stringify(sandbox.window.PESTICIDES_DB) === JSON.stringify(JSON.parse(srcMain));
  const sameApps = JSON.stringify(sandbox.window.APPLICATIONS) === JSON.stringify(JSON.parse(srcApps));
  const n = sandbox.window.PESTICIDES_DB?.products?.length ?? 0;
  check(sameMain && sameApps, `${rel}: 埋め込んだデータが src/data と同じ (${n} 商品)`);
  check(html.includes(version), `${rel}: 版 ${version} の表記がある`);
}

console.log(`\nResult: ${fail === 0 ? "OK" : `${fail} 件の失敗`}`);
if (fail > 0) process.exit(1);

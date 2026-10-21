/**
 * 抵抗性・耐性の報告 (resistance.json) の読み込み
 * - シングルHTMLバンドル版: window.RESISTANCE_DB が埋め込まれる
 * - 開発版: data/resistance.json を fetch
 */

let resistanceCache = null;

export async function loadResistance() {
  if (resistanceCache) return resistanceCache;

  if (typeof window !== "undefined" && window.RESISTANCE_DB) {
    resistanceCache = window.RESISTANCE_DB;
    return resistanceCache;
  }

  // 読めないときに空のデータとして扱うと、すべての剤が「報告なし」と表示されて誤解を招く。
  // キャッシュせずエラーとして伝え、app.js が抵抗性の欄に読込エラーを出す
  const res = await fetch("data/resistance.json");
  if (!res.ok) throw new Error(`抵抗性データ (data/resistance.json) の読込に失敗しました: ${res.status}`);
  resistanceCache = await res.json();
  return resistanceCache;
}

/**
 * 適用部の遅延読み込み
 * - シングルHTMLバンドル版: window.APPLICATIONS が埋め込まれる
 * - 開発版: data/applications.json を fetch
 */

let cache = null;

export async function loadApplications() {
  if (cache) return cache;

  // バンドル版: インライン埋め込み済み
  if (typeof window !== "undefined" && window.APPLICATIONS) {
    cache = window.APPLICATIONS.applications || {};
    return cache;
  }

  // 開発版: fetch
  try {
    const res = await fetch("data/applications.json");
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const data = await res.json();
    cache = data.applications || {};
    return cache;
  } catch (e) {
    console.warn("適用部データの読込に失敗:", e);
    cache = {};
    return cache;
  }
}

export function getApplicationsFor(regNo) {
  if (!cache) return null;
  return cache[String(regNo)] || [];
}

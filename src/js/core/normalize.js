/**
 * 文字列正規化ユーティリティ
 * - 半角カナ → 全角カナ
 * - ひらがな → カタカナ
 * - 大文字統一
 * - 全角英数 → 半角
 */

function hiraToKata(str) {
  return str.replace(/[ぁ-ゖ]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

export function normalize(str) {
  if (!str) return "";
  let s = String(str).normalize("NFKC");
  s = hiraToKata(s);
  s = s.toUpperCase();
  s = s.replace(/\s+/g, "");
  return s;
}

/** 登録番号の正規化: "第12345号" → 12345, "12345" → 12345 */
export function parseRegNo(str) {
  if (!str) return null;
  const m = String(str).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** RACコードの正規化: "IRAC 4A", "4A", "irac4a" → "4A" */
export function normalizeRacQuery(str) {
  if (!str) return "";
  const s = String(str).toUpperCase().replace(/\s+/g, "");
  return s.replace(/^(IRAC|FRAC|HRAC)/, "");
}

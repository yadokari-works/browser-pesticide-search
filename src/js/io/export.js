/**
 * エクスポート
 * - TSV / CSV / Markdown / JSON
 */

function flattenIngredients(ings) {
  return ings.map(i => {
    const rac = i.rac_code ? ` [${i.rac_code}]` : "";
    const density = i.density ? ` (${i.density})` : "";
    return `${i.name}${density}${rac}`;
  }).join(" + ");
}

// 表形式 (TSV / CSV / Markdown) の列。登録状態と失効年月日は、失効剤を現行剤と取り違えないために必ず出す
const EXPORT_COLUMNS = [
  ["登録番号", p => p.reg_no],
  ["種類名", p => p.type_name],
  ["商品名(登録名)", p => p.product_name],
  ["会社名", p => p.company],
  ["用途", p => (p.categories || [p.category]).join("+")],
  ["剤型", p => p.formulation],
  ["成分", p => flattenIngredients(p.ingredients)],
  ["混合数", p => p.mix_count],
  ["登録年月日", p => p.registration_date],
  ["状態", p => p.status || "有効"],
  ["失効年月日", p => p.expire_date || ""],
];

/**
 * 表計算ソフトが数式として扱う文字 (= + - @、タブ、改行) で始まるセルの先頭に ' を付ける
 * (CSV インジェクション対策。データ由来の文字列をそのまま数式にしない)
 */
function neutralizeFormula(s) {
  return /^[=+\-@\t\r\n]/.test(s) ? `'${s}` : s;
}

function cellText(v) {
  return v == null ? "" : neutralizeFormula(String(v));
}

function escapeCsv(s) {
  const str = cellText(s);
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** TSV のセル: タブと改行は区切りと区別できないので空白にする */
function escapeTsv(s) {
  return cellText(s).replace(/[\t\r\n]+/g, " ");
}

/** Markdown の表のセル: | と改行を表を壊さない形にする */
function escapeMd(s) {
  return (s == null ? "" : String(s)).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function exportTSV(products) {
  const rows = products.map(p => EXPORT_COLUMNS.map(([, f]) => f(p)));
  return [EXPORT_COLUMNS.map(([h]) => h), ...rows].map(r => r.map(escapeTsv).join("\t")).join("\n");
}

export function exportCSV(products) {
  const rows = products.map(p => EXPORT_COLUMNS.map(([, f]) => f(p)));
  // 先頭の BOM で、Excel が UTF-8 として開く (無いと Shift_JIS として読まれて文字化けする)
  return "\uFEFF" + [EXPORT_COLUMNS.map(([h]) => h), ...rows].map(r => r.map(escapeCsv).join(",")).join("\n");
}

export function exportMarkdown(products) {
  // Markdown は読む用なので、混合数と登録年月日は省く
  const cols = EXPORT_COLUMNS.filter(([h]) => h !== "混合数" && h !== "登録年月日");
  const lines = [
    `| ${cols.map(([h]) => h).join(" | ")} |`,
    `|${cols.map(() => "---").join("|")}|`,
  ];
  for (const p of products) {
    lines.push(`| ${cols.map(([, f]) => escapeMd(f(p))).join(" | ")} |`);
  }
  return lines.join("\n");
}

/** JSON は、画面用に付けた内部の欄 (_ で始まる _app_pairs など) を除いて書き出す */
export function exportJSON(products) {
  return JSON.stringify(products, (key, value) => (key.startsWith("_") ? undefined : value), 2);
}

export function download(filename, content, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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

function escapeCsv(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function exportTSV(products) {
  const header = ["登録番号", "種類名", "商品名(登録名)", "会社名", "用途", "剤型", "成分", "混合数", "登録年月日"];
  const rows = products.map(p => [
    p.reg_no,
    p.type_name,
    p.product_name,
    p.company,
    (p.categories || [p.category]).join("+"),
    p.formulation,
    flattenIngredients(p.ingredients),
    p.mix_count,
    p.registration_date,
  ]);
  return [header, ...rows].map(r => r.join("\t")).join("\n");
}

export function exportCSV(products) {
  const header = ["登録番号", "種類名", "商品名(登録名)", "会社名", "用途", "剤型", "成分", "混合数", "登録年月日"];
  const rows = products.map(p => [
    p.reg_no,
    p.type_name,
    p.product_name,
    p.company,
    (p.categories || [p.category]).join("+"),
    p.formulation,
    flattenIngredients(p.ingredients),
    p.mix_count,
    p.registration_date,
  ]);
  return [header, ...rows].map(r => r.map(escapeCsv).join(",")).join("\n");
}

export function exportMarkdown(products) {
  const lines = [
    "| 登録番号 | 種類名 | 商品名(登録名) | 会社名 | 用途 | 剤型 | 成分 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const p of products) {
    lines.push(
      `| ${p.reg_no} | ${p.type_name} | ${p.product_name} | ${p.company} | ${(p.categories||[p.category]).join("+")} | ${p.formulation} | ${flattenIngredients(p.ingredients)} |`
    );
  }
  return lines.join("\n");
}

export function exportJSON(products) {
  return JSON.stringify(products, null, 2);
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

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

/**
 * 作物名を検索インデックス用に展開する。
 * "(○○を除く)" / "（○○を除く）" を含む場合は括弧手前のメイン作物名のみ返す
 * (除外指定された作物は検索ヒットさせない)。
 * 例: "かんきつ(みかんを除く)" → ["かんきつ"]
 *     "ねぎ(根深ねぎ)"        → ["ねぎ(根深ねぎ)"]  (「除く」無しは原文)
 */
export function expandSearchableCrops(crop) {
  if (!crop) return [];
  const s = String(crop);
  const m = s.match(/^(.*?)[（(]([^（()）]*)[)）]\s*$/);
  if (m && /(除く|のぞく)/.test(m[2])) {
    const base = m[1].trim();
    return base ? [base] : [];
  }
  return [s];
}

/**
 * 会社名と商品名を比較し、商品名の頭から会社略称プレフィックスを除いた名称を返す。
 * 1) 既知略称マップ (日農/ホクコー/カヤク等) を優先
 * 2) 会社名から「株式会社」等を除いた根の頭一致を試す (2 文字以上)
 * 除去結果が空になる場合は元の商品名を返す。
 */
const COMPANY_ALIAS_MAP = {
  "日本農薬株式会社": ["日農", "日本農薬"],
  "北興化学工業株式会社": ["ホクコー", "北興化学"],
  "日本化薬株式会社": ["日本化薬", "カヤク"],
  "大日本除蟲菊株式会社": ["金鳥", "大日本除蟲菊"],
  "バイエルクロップサイエンス株式会社": ["バイエル"],
  "シンジェンタ ジャパン株式会社": ["シンジェンタ"],
  "日産化学株式会社": ["日産化学", "日産"],
  "住友化学株式会社": ["住友化学", "住友"],
  "三井化学クロップ&ライフソリューション株式会社": ["三井東圧", "三井"],
  "クミアイ化学工業株式会社": ["クミアイ化学", "クミアイ"],
  "三共株式会社": ["三共"],
  "北海三共株式会社": ["北海三共"],
  "九州三共株式会社": ["九州三共"],
  "石原産業株式会社": ["石原産業", "石原"],
  "協友アグリ株式会社": ["協友"],
};

export function stripCompanyFromName(productName, company) {
  if (!productName) return productName || "";
  const name = String(productName);
  const comp = String(company || "");
  for (const alias of (COMPANY_ALIAS_MAP[comp] || [])) {
    if (alias && name.startsWith(alias)) {
      const rest = name.slice(alias.length).trim();
      if (rest) return rest;
    }
  }
  const root = comp.replace(/(株式会社|合同会社|有限会社|協同組合|農業協同組合連合会)/g, "").trim();
  for (let n = root.length; n >= 2; n--) {
    const prefix = root.slice(0, n);
    if (name.startsWith(prefix)) {
      const rest = name.slice(n).trim();
      if (rest) return rest;
    }
  }
  return name;
}

/**
 * RACコード文字列を IRAC / FRAC / HRAC 別に分類。
 * - 複合表記: "UN(I*), M2(F*)" のように (I*)/(F*)/(H*) タグ付き → タグで振り分け
 * - 単独コード: categories から推定 (殺虫剤→I, 殺菌剤→F, 除草剤→H)
 */
export function splitRacCode(racCode, categories) {
  const out = { I: [], F: [], H: [] };
  if (!racCode) return out;
  const s = String(racCode);
  const cats = Array.isArray(categories) ? categories : [];

  if (/\((I|F|H)\*\)/.test(s)) {
    const parts = s.split(/[,、]/);
    for (const part of parts) {
      const m = part.match(/^\s*(.+?)\s*\((I|F|H)\*\)\s*$/);
      if (m) {
        const code = m[1].trim();
        if (code) out[m[2]].push(code);
      }
    }
    return out;
  }

  const code = s.trim();
  if (!code) return out;
  const joined = cats.join("");
  if (joined.includes("殺虫")) out.I.push(code);
  if (joined.includes("殺菌")) out.F.push(code);
  if (joined.includes("除草")) out.H.push(code);
  return out;
}

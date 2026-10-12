/**
 * 文字列正規化ユーティリティ
 * - 半角カナ → 全角カナ
 * - ひらがな → カタカナ
 * - 大文字統一
 * - 全角英数 → 半角
 * - 適用作物名の分解と、作物群・別名の展開
 */

import { CROP_GROUPS, CROP_ALIASES } from "./crop_groups.js";

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

/** "、" で区切る。ただし括弧の内側の "、" では区切らない ("うり類(漬物用)" などを壊さない) */
function splitTopLevel(str) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of str) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "、" && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 適用作物名を {base, qualifier, excludes} に分解する (括弧は NFKC で半角にそろえる)。
 * 例: "かんきつ(みかんを除く)"                     → base かんきつ, excludes [みかん]
 *     "豆類(未成熟、ただし、えだまめを除く)"        → base 豆類, qualifier 未成熟, excludes [えだまめ]
 *     "野菜類(施設栽培)"                           → base 野菜類, qualifier 施設栽培
 *     "うり科野菜(すいか、うり類(漬物用)を除く)"    → base うり科野菜, excludes [すいか, うり類(漬物用)]
 */
function parseCropName(crop) {
  const t = String(crop).normalize("NFKC").trim();
  const i = t.indexOf("(");
  const plain = { base: t, qualifier: "", excludes: [] };
  if (i <= 0 || !t.endsWith(")")) return plain;
  const inner = t.slice(i + 1, -1);
  let depth = 0;
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return plain;  // "西洋芝(ベントグラス)(生産圃場)" のような並びは分解しない
  }
  const base = t.slice(0, i).trim();
  if (!/(除く|のぞく)$/.test(inner)) return { base, qualifier: inner, excludes: [] };
  // 括弧の外側にある "ただし、" で条件と除外を分ける
  // ("野菜類(…、豆類(種実、ただし、らっかせいを除く)、かんしょを除く)" の内側の "ただし" では分けない)
  let cut = -1;
  depth = 0;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && inner.startsWith("ただし、", k)) { cut = k; break; }
  }
  const qualifier = cut >= 0 ? inner.slice(0, cut).replace(/、$/, "").trim() : "";
  const excludes = splitTopLevel((cut >= 0 ? inner.slice(cut + 4) : inner).replace(/を(除く|のぞく)$/, ""));
  return { base, qualifier, excludes };
}

/**
 * 作物名を検索インデックス用に展開する。
 * "(○○を除く)" / "（○○を除く）" を含む場合は括弧手前のメイン作物名のみ返す
 * (除外指定された作物は検索ヒットさせない)。"、ただし、" の前の条件は残す。
 * 例: "かんきつ(みかんを除く)"               → ["かんきつ"]
 *     "豆類(未成熟、ただし、えだまめを除く)"  → ["豆類(未成熟)"]
 *     "ねぎ(根深ねぎ)"                       → ["ねぎ(根深ねぎ)"]  (「除く」無しは原文)
 */
export function expandSearchableCrops(crop) {
  if (!crop) return [];
  const s = String(crop);
  const { base, qualifier, excludes } = parseCropName(s);
  if (!excludes.length) return [s];
  const head = qualifier ? `${base}(${qualifier})` : base;
  return head ? [head] : [];
}

// 作物群名 (正規化済み) → 含まれる作物名 (正規化済み) の配列
const GROUP_MEMBERS = new Map(
  Object.entries(CROP_GROUPS).map(([g, names]) => [normalize(g), names.map(normalize)])
);
// 作物群名の後ろの括弧のうち、含まれる作物を狭めない条件 (栽培方法など)。
// これ以外の括弧 (例 "うり類(漬物用)" "とうもろこし(子実)") は作物群の一部だけを指すため展開しない。
const CONDITION_QUALIFIERS = new Set(
  ["施設栽培", "露地栽培", "苗木", "秋播", "秋播栽培", "ポット・プランター等の容器栽培"].map(normalize)
);
const memberCache = new Map();
const NO_MEMBERS = new Set();

function groupFor(base, qualifier) {
  const b = normalize(base), q = normalize(qualifier);
  if (!q) return GROUP_MEMBERS.get(b) || null;
  return GROUP_MEMBERS.get(normalize(`${base}(${qualifier})`))  // 豆類(種実) など
    || (GROUP_MEMBERS.has(b) && GROUP_MEMBERS.get(q))            // 芝(日本芝) → 日本芝
    || (CONDITION_QUALIFIERS.has(q) && GROUP_MEMBERS.get(b))     // 野菜類(施設栽培) → 野菜類
    || null;
}

// 作物名 (正規化済み) → 別名 (正規化済み) の配列、と その逆引き
const ALIASES = new Map(
  Object.entries(CROP_ALIASES).map(([n, words]) => [normalize(n), words.map(normalize)])
);
const ALIAS_TO_NAME = new Map();
for (const [n, words] of ALIASES) for (const w of words) ALIAS_TO_NAME.set(w, n);

/**
 * "を除く" に書かれた語 e が指す作物名 (正規化済み) を out に集める。
 * 除外漏れは「除外された作物の検索で剤が出る」誤表示になるため、迷う場合は広めに除く。
 */
function collectExcluded(e, members, out) {
  const ne = normalize(e);
  out.add(ne);
  const name = ALIAS_TO_NAME.get(ne);
  if (name) out.add(name);                                    // 温州みかん → みかん
  const sub = cropGroupMembers(e);                            // 除外が作物群 ("豆類(種実、ただし、…を除く)" も)
  for (const m of sub) out.add(m);
  if (sub.size || name || members.includes(ne)) return;
  for (const m of GROUP_MEMBERS.get(ne + "類") || []) out.add(m);  // まつ → まつ類
  const t = String(e).normalize("NFKC").trim();
  const i = t.indexOf("(");
  if (i > 0) collectExcluded(t.slice(0, i), members, out);    // まつ(生立木) → まつ、小麦(秋播) → 小麦
  if (/類$/.test(ne)) {
    // 分類表に無い旧作物群名 (例 "とうがらし類"): 名前がそれで終わる作物群
    // (ピーマン及びとうがらし類) の所属作物と、"類" を除いた語を含む作物を除く
    const stem = ne.slice(0, -1);
    for (const [g, ms] of GROUP_MEMBERS) if (g.endsWith(ne)) for (const m of ms) out.add(m);
    for (const m of members) if (stem && m.includes(stem)) out.add(m);
  }
}

/**
 * 適用作物が作物群 (例 "非結球あぶらな科葉菜類") のとき、そこに含まれる作物名とその別名を
 * 正規化して Set で返す。"を除く" で除外された作物 (除外が作物群ならその所属作物も) は含めない。
 * 作物群でなければ空の Set。
 * 検索語との照合は部分一致でなく完全一致で行う (例: "はくさい" で検索したとき、
 * 所属作物 "非結球はくさい" に部分一致して 非結球あぶらな科葉菜類 の剤が出るのを防ぐ)。
 * 出典は crop_groups.js の冒頭を参照。分類表に載っていない作物は拾えない。
 */
export function cropGroupMembers(crop) {
  if (!crop) return NO_MEMBERS;
  const s = String(crop);
  let set = memberCache.get(s);
  if (set) return set;
  memberCache.set(s, NO_MEMBERS);  // 自己参照する除外があっても無限再帰しないように
  const { base, qualifier, excludes } = parseCropName(s);
  const members = groupFor(base, qualifier);
  if (!members) {
    set = NO_MEMBERS;
  } else {
    const excluded = new Set();
    for (const e of excludes) collectExcluded(e, members, excluded);
    set = new Set();
    for (const m of members) {
      if (excluded.has(m)) continue;
      set.add(m);
      for (const w of ALIASES.get(m) || []) if (!excluded.has(w)) set.add(w);
    }
  }
  memberCache.set(s, set);
  return set;
}

const aliasCache = new Map();

/**
 * 適用作物が作物群でない作物 (例 "みずな" "みかん(施設栽培)") のとき、その作物の別名
 * (分類表の「作物名に含まれる別名、地方名、品種名等の例」) を正規化して Set で返す。
 * 別名で検索したとき、正式名で登録された行も一致させるために使う (例: 京菜 → みずな、
 * さつまいも → かんしょ)。作物欄の括弧 (栽培条件など) は問わず、括弧ごとの作物名
 * ("アマランサス(茎葉)") に別名があればそちらを使う。"(…を除く)" で除外された語と、
 * その語の別名は含めない (例 "なばな類(オータムポエムを除く)")。該当しなければ空の Set。
 * 照合は cropGroupMembers と同じく完全一致で行う。
 */
export function cropAliasSet(crop) {
  if (!crop) return NO_MEMBERS;
  const s = String(crop);
  let set = aliasCache.get(s);
  if (set) return set;
  const { base, qualifier, excludes } = parseCropName(s);
  const words = (qualifier && ALIASES.get(normalize(`${base}(${qualifier})`)))
    || ALIASES.get(normalize(base));
  if (!words) {
    set = NO_MEMBERS;
  } else {
    const excluded = new Set();
    for (const e of excludes) {
      const ne = normalize(e);
      excluded.add(ne);
      for (const w of ALIASES.get(ne) || []) excluded.add(w);
    }
    set = new Set(words.filter(w => !excluded.has(w)));
    if (!set.size) set = NO_MEMBERS;
  }
  aliasCache.set(s, set);
  return set;
}

/**
 * 適用行の作物欄・使用場所欄それぞれについて、その欄の作物名で引ける語の Set を配列で返す。
 * 作物群なら所属作物とその別名 (cropGroupMembers)、作物群でなければその作物の別名 (cropAliasSet)。
 */
export function applicationCropMembers(a) {
  const out = [];
  for (const v of [a.crop, a.place]) {
    if (!v) continue;
    const g = cropGroupMembers(v);
    const s = g.size ? g : cropAliasSet(v);
    if (s.size) out.push(s);
  }
  return out;
}

/** applicationCropMembers の Set の配列のどれかに q (正規化済み) があるか */
export function membersHave(sets, q) {
  if (!sets) return false;
  for (const s of sets) if (s.has(q)) return true;
  return false;
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

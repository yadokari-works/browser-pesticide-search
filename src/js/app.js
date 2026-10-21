/**
 * 農薬検索アプリ メインエントリ
 */

import { buildIndex, search, buildRowCondition, hasRowCondition, filterApplications } from "./core/search.js";
import { applyFilters, DEFAULT_FILTERS, countFormulations, attachBrandedFlags, groupKeyOf } from "./core/filter.js";
import { splitRacCode, stripCompanyFromName, expandSearchableCrops, searchablePest, normalize, cropGroupMembers, appEntry, entryHasCrop } from "./core/normalize.js";
import { buildResistanceIndex, resolveTaxa, findResistance, recordsByRacCode, summarizeResistance, pestNamesForTaxa, isOverseasRecord, RESISTANCE_LEVELS, RES_PREFECTURES } from "./core/resistance.js";
import { exportTSV, exportCSV, exportMarkdown, exportJSON, download } from "./io/export.js";
import { loadApplications, getApplicationsFor } from "./io/applications.js";
import { loadResistance } from "./io/resistance_data.js";

// RAC ステータスの表示ラベル (rac_manual.json と対応)
const RAC_STATUS_LABEL = {
  out_of_scope: "対象外",
  legacy: "古典未分類",
  recent: "新規未収録",
};

// IRAC/FRAC/HRAC 別バッジ HTML を生成。コードが無く rac_status のみある場合は status バッジを返す。
function racBadgesHtml(ingredient, categories) {
  const split = splitRacCode(ingredient.rac_code, categories || []);
  const parts = [];
  if (split.I.length) parts.push(`<span class="badge rac-irac">IRAC: ${split.I.map(escapeHtml).join(", ")}</span>`);
  if (split.F.length) parts.push(`<span class="badge rac-frac">FRAC: ${split.F.map(escapeHtml).join(", ")}</span>`);
  if (split.H.length) parts.push(`<span class="badge rac-hrac">HRAC: ${split.H.map(escapeHtml).join(", ")}</span>`);
  if (parts.length === 0 && ingredient.rac_status) {
    const label = RAC_STATUS_LABEL[ingredient.rac_status] || "未分類";
    parts.push(`<span class="badge rac-${ingredient.rac_status}" title="${escapeHtml(ingredient.rac_reason || '')}">${label}</span>`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

// グローバル状態
const state = {
  db: null,
  index: null,
  filters: {
    ...DEFAULT_FILTERS,
    categories: new Set(DEFAULT_FILTERS.categories),
    statuses: new Set(DEFAULT_FILTERS.statuses),
  },
  currentQuery: "",
  searchMode: "and", // "and"=全トークン一致 | "or"=いずれか一致
  appScope: "specified", // 適用表の表示範囲: "specified"=指定した作物・病害虫の行のみ | "all"=剤の登録すべて
  detailRegNo: null, // 詳細に表示中の商品 (表示範囲の切替で再描画するため)
  racSystem: null, // null=自動(全系統) | "I"|"F"|"H" = IRAC/FRAC/HRAC に限定
  currentResults: [],
  currentGroups: [],
  selectedFormulations: null,
  cropSuggestions: [],
  pestSuggestions: [],
  view: "search", // "search"=剤を探す | "resistance"=抵抗性を見る
  resistance: null, // buildResistanceIndex の結果
  resistanceError: null, // 抵抗性データを読めなかったときのメッセージ
  showOverseas: true, // 海外の報告を表示するか (端末に覚えさせる)
  res: { crop: "", pest: "", code: null, hostOnly: false }, // 抵抗性の画面の入力と、選んだ系統
};

// DOM 参照
const $ = sel => document.querySelector(sel);
const searchInput = $("#search-input");
const sidebar = $("#sidebar");
const resultList = $("#result-list");
const resultCount = $("#result-count");
const detailOverlay = $("#detail-overlay");
const detailContent = $("#detail-content");

// 初期化
async function init() {
  try {
    const dbRaw = window.PESTICIDES_DB || null;
    if (!dbRaw) {
      const res = await fetch("data/pesticides.json");
      state.db = await res.json();
    } else {
      state.db = dbRaw;
    }

    const apps = await loadApplications();
    state.index = buildIndex(state.db.products, apps);
    attachCropsPests(state.index, apps);
    attachBrandedFlags(state.db.products);
    // 抵抗性データを読めなくても検索は使えるようにする (抵抗性の欄と画面に読込エラーを出す)
    try {
      state.resistance = buildResistanceIndex(await loadResistance());
    } catch (e) {
      state.resistanceError = e.message;
      console.warn(e);
    }
    state.showOverseas = loadOverseasPref();
    renderHeader();
    renderFilters();
    updateResults();
    if (state.view === "resistance") renderResistanceView();
  } catch (e) {
    resultList.innerHTML = `<div class="empty">データ読込エラー: ${escapeHtml(e.message)}<br><small>scripts/build_data.py を実行してから再試行してください。</small></div>`;
    console.error(e);
  }
}

/**
 * サイドバーの絞り込み (filter.js) が使う派生欄を商品に付ける。適用行の正規化は buildIndex が
 * 行ったもの (app_entries) をそのまま使い、作物・病害虫の候補の件数を数える。
 */
function attachCropsPests(index, applications) {
  const cropCount = new Map();
  const pestCount = new Map();
  for (const entry of index) {
    const p = entry.product;
    p._crops_norm = entry.norm_crops;
    p._crop_members = entry.crop_members;
    p._pests_norm = entry.norm_pests;
    p._app_pairs = entry.app_entries;
    // 候補は "(…を除く)" を取り除いた名前で数える (原文を選ぶと、その語で一致する行が無く 0 件になるため)
    for (const a of applications[String(p.reg_no)] || []) {
      if (a.crop) for (const c of expandSearchableCrops(a.crop)) cropCount.set(c, (cropCount.get(c) || 0) + 1);
      if (a.pest) {
        const n = searchablePest(a.pest);
        pestCount.set(n, (pestCount.get(n) || 0) + 1);
      }
    }
  }
  state.cropSuggestions = [...cropCount.entries()].sort((a, b) => b[1] - a[1]);
  state.pestSuggestions = [...pestCount.entries()].sort((a, b) => b[1] - a[1]);
}

function toReiwa(dateStr) {
  if (!dateStr) return "";
  const m = String(dateStr).match(/(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return dateStr;
  const y = parseInt(m[1], 10);
  const mo = m[2] ? parseInt(m[2], 10) : null;
  const d = m[3] ? parseInt(m[3], 10) : null;
  if (y < 2019) return dateStr;
  const reiwaY = y - 2018;
  const yStr = reiwaY === 1 ? "元" : String(reiwaY);
  let out = `令和${yStr}年`;
  if (mo) out += `${mo}月`;
  if (d) out += `${d}日`;
  return out;
}

function renderHeader() {
  const { stats, sources } = state.db;
  const active = stats.active ?? stats.total_products;
  const cancelled = stats.cancelled ?? 0;
  $("#header-stats").textContent =
    `現行 ${active.toLocaleString()} 件 / 失効 ${cancelled.toLocaleString()} 件 / RAC ${Math.round(stats.rac_match_rate * 100)}% マッチ`;
  $("#header-subtitle").textContent =
    `${toReiwa(sources.famic)} FAMIC登録情報 / ${toReiwa(sources.famic_cancelled || "")} 失効情報 / RAC ${toReiwa(sources.rac)}版 / 最終更新: ${toReiwa(state.db.generated_at)}`;
}

function renderFilters() {
  const catDiv = $("#filter-categories");
  const counts = { 殺虫剤: 0, 殺菌剤: 0, 除草剤: 0 };
  for (const p of state.db.products) {
    const cats = p.categories || [p.category];
    for (const c of cats) counts[c] = (counts[c] || 0) + 1;
  }
  catDiv.innerHTML = ["殺虫剤", "殺菌剤", "除草剤"]
    .map(c => `
      <label class="filter-option">
        <input type="checkbox" data-cat="${c}" ${state.filters.categories.has(c) ? "checked" : ""}>
        <span class="badge category-${c}">${c}</span>
        <span class="filter-count">${counts[c] || 0}</span>
      </label>
    `).join("");
  catDiv.querySelectorAll("input").forEach(cb =>
    cb.addEventListener("change", e => {
      const c = e.target.dataset.cat;
      if (e.target.checked) state.filters.categories.add(c);
      else state.filters.categories.delete(c);
      updateResults();
    })
  );

  const racSysDiv = $("#filter-rac-system");
  const RAC_SYSTEMS = [
    { value: "", label: "自動 (全系統)" },
    { value: "I", label: "IRAC (殺虫)" },
    { value: "F", label: "FRAC (殺菌)" },
    { value: "H", label: "HRAC (除草)" },
  ];
  racSysDiv.innerHTML = RAC_SYSTEMS.map(s => `
    <label class="filter-option">
      <input type="radio" name="rac-system" value="${s.value}" ${(state.racSystem || "") === s.value ? "checked" : ""}>
      <span>${s.label}</span>
    </label>
  `).join("");
  racSysDiv.querySelectorAll("input").forEach(rb =>
    rb.addEventListener("change", e => {
      state.racSystem = e.target.value || null;
      updateResults();
    })
  );

  const statusDiv = $("#filter-statuses");
  const statusCounts = { 有効: 0, 失効: 0 };
  for (const p of state.db.products) {
    const s = p.status || "有効";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  statusDiv.innerHTML = ["有効", "失効"].map(s => `
    <label class="filter-option">
      <input type="checkbox" data-status="${s}" ${state.filters.statuses.has(s) ? "checked" : ""}>
      <span class="badge status-${s === '有効' ? 'active' : 'inactive'}">${s}</span>
      <span class="filter-count">${statusCounts[s] || 0}</span>
    </label>
  `).join("");
  statusDiv.querySelectorAll("input").forEach(cb =>
    cb.addEventListener("change", e => {
      const s = e.target.dataset.status;
      if (e.target.checked) state.filters.statuses.add(s);
      else state.filters.statuses.delete(s);
      updateResults();
    })
  );

  $("#filter-household").checked = state.filters.excludeHousehold;
  $("#filter-household").addEventListener("change", e => {
    state.filters.excludeHousehold = e.target.checked;
    updateResults();
  });

  $("#filter-branded").checked = state.filters.excludeBranded;
  $("#filter-branded").addEventListener("change", e => {
    state.filters.excludeBranded = e.target.checked;
    updateResults();
  });

  $("#filter-mix").checked = state.filters.mixOnly;
  $("#filter-mix").addEventListener("change", e => {
    state.filters.mixOnly = e.target.checked;
    updateResults();
  });

  const formDiv = $("#filter-formulations");
  const forms = countFormulations(state.db.products);
  formDiv.innerHTML = `<option value="">全て (${state.db.products.length})</option>` +
    [...forms.entries()].slice(0, 50)
      .map(([name, cnt]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)} (${cnt})</option>`).join("");
  formDiv.addEventListener("change", e => {
    const v = e.target.value;
    state.filters.formulations = v ? new Set([v]) : null;
    updateResults();
  });

  const cropList = $("#crop-suggestions");
  if (cropList && state.cropSuggestions) {
    cropList.innerHTML = state.cropSuggestions
      .slice(0, 1500)
      .map(([name, cnt]) => `<option value="${escapeHtml(name)}">${cnt} 件</option>`)
      .join("");
  }
  const cropInput = $("#filter-crop");
  if (cropInput) {
    cropInput.value = state.filters.crop || "";
    cropInput.addEventListener("input", e => {
      state.filters.crop = e.target.value.trim();
      updateResults();
    });
  }

  const pestList = $("#pest-suggestions");
  if (pestList && state.pestSuggestions) {
    pestList.innerHTML = state.pestSuggestions
      .slice(0, 1500)
      .map(([name, cnt]) => `<option value="${escapeHtml(name)}">${cnt} 件</option>`)
      .join("");
  }
  const pestInput = $("#filter-pest");
  if (pestInput) {
    pestInput.value = state.filters.pest || "";
    pestInput.addEventListener("input", e => {
      state.filters.pest = e.target.value.trim();
      updateResults();
    });
  }
}

function updateResults() {
  let results = search(state.currentQuery, state.index, state.racSystem, state.searchMode, {
    crop: state.filters.crop,
    pest: state.filters.pest,
  });
  results = applyFilters(results, state.filters);
  state.currentResults = results;
  state.currentGroups = groupByTypeAndIngredients(results);
  renderResults(state.currentGroups, results.length);
}

/**
 * 種類名 + 成分構成 (成分名・濃度) でグループ化する。
 * 種類名だけだと、ダコニール1000 (TPN 40%) / ダコニールエース (53%) /
 * ダコニールアルファ (82.5%) が同じ「TPN水和剤」に統合され、代表 1 件しか
 * 一覧に出なくなるため。会社違いの同一処方 (クミアイダコニール1000 等) は
 * 従来どおり 1 グループにまとまる。
 */
function groupByTypeAndIngredients(products) {
  const map = new Map();
  for (const p of products) {
    const typeName = p.type_name || p.product_name;
    const key = p._group || groupKeyOf(p);
    let g = map.get(key);
    if (!g) {
      g = { type_name: typeName, products: [] };
      map.set(key, g);
    }
    g.products.push(p);
  }
  return [...map.values()];
}

function renderResults(groups, productCount) {
  resultCount.textContent = `${groups.length.toLocaleString()} 種類 / ${productCount.toLocaleString()} 商品`;
  if (groups.length === 0) {
    resultList.innerHTML = `<div class="empty">該当する剤がありません。</div>`;
    return;
  }
  const MAX = 500;
  const shown = groups.slice(0, MAX);
  resultList.innerHTML = shown.map(renderGroupCard).join("");
  if (groups.length > MAX) {
    resultList.innerHTML += `<div class="empty" style="padding:20px;">上位 ${MAX} 種類を表示。絞り込みで件数を減らしてください。</div>`;
  }
  resultList.querySelectorAll(".result-card").forEach(card =>
    card.addEventListener("click", () => openGroupDetail(Number(card.dataset.gidx)))
  );
}

function renderGroupCard(g, idx) {
  const rep = g.products.find(p => p.status !== "失効") || g.products[0];
  // グループ内の全商品のカテゴリを和集合 (殺虫殺菌両用剤や混在グループの正確な表示)
  const catOrder = ["殺虫剤", "殺菌剤", "除草剤"];
  const catSet = new Set();
  for (const p of g.products) {
    for (const c of (p.categories || [p.category])) catSet.add(c);
  }
  const cats = catOrder.filter(c => catSet.has(c));
  const ingBadges = rep.ingredients.map(i => {
    return `<span class="badge ingredient">${escapeHtml(i.name)}${racBadgesHtml(i, cats)}</span>`;
  }).join("");
  const catBadges = cats.map(c => `<span class="badge category-${c}">${c}</span>`).join(" ")
    + (g.products.some(p => p.original_category === "農薬肥料") ? ` <span class="badge" title="用途（FAMIC原表記）">農薬肥料</span>` : "");
  const activeCount = g.products.filter(p => p.status !== "失効").length;
  const cancelledCount = g.products.length - activeCount;
  const statusBadge = (activeCount > 0 ? `<span class="badge status-active">有効 ${activeCount}</span>` : "")
    + (cancelledCount > 0 ? ` <span class="badge status-inactive">失効 ${cancelledCount}</span>` : "");
  const isAllCancelled = activeCount === 0;
  const companies = [...new Set(g.products.map(p => p.company))];
  const companyText = companies.length <= 3
    ? companies.join(" / ")
    : `${companies.slice(0,3).join(" / ")} 他 ${companies.length - 3} 社`;
  const formCount = new Map();
  for (const p of g.products) {
    const k = p.formulation || "(不明)";
    formCount.set(k, (formCount.get(k) || 0) + 1);
  }
  const formText = [...formCount.entries()].slice(0, 3)
    .map(([k, v]) => formCount.size > 1 ? `${k}(${v})` : k).join(" / ");
  const titleMain = stripCompanyFromName(rep.product_name, rep.company);
  const showTypeSub = g.type_name && g.type_name !== titleMain;
  const subParts = [];
  if (showTypeSub) subParts.push(`種類: ${escapeHtml(g.type_name)}`);
  subParts.push(`${g.products.length} 商品 / ${companies.length} 社`);
  return `
    <div class="result-card group-card ${isAllCancelled ? 'cancelled' : ''}" data-gidx="${idx}">
      <div class="result-header">
        <div class="result-title">${escapeHtml(titleMain)}<span class="result-title-sub">${subParts.join(" · ")}</span></div>
        <span>${catBadges} ${statusBadge}</span>
      </div>
      <div class="result-meta">
        <span>${escapeHtml(companyText)}</span>
        ${formText ? `<span>·</span><span>${escapeHtml(formText)}</span>` : ""}
      </div>
      <div class="result-ingredients">${ingBadges}</div>
    </div>
  `;
}

async function openGroupDetail(groupIdx) {
  const g = state.currentGroups[groupIdx];
  if (!g) return;

  detailOverlay.classList.add("open");
  detailContent.innerHTML = `<div class="loading">適用情報を読込中...</div>`;
  await loadApplications();

  const rep = g.products.find(p => p.status !== "失効") || g.products[0];
  const catOrder = ["殺虫剤", "殺菌剤", "除草剤"];
  const catSet = new Set();
  for (const p of g.products) {
    for (const c of (p.categories || [p.category])) catSet.add(c);
  }
  const cats = catOrder.filter(c => catSet.has(c));
  const catBadges = cats.map(c => `<span class="badge category-${c}">${c}</span>`).join(" ");
  const ingRows = rep.ingredients.map(i => {
    const racEl = racBadgesHtml(i, cats);
    const reason = (!i.rac_code && i.rac_status && i.rac_reason)
      ? ` <span class="rac-reason">(${escapeHtml(i.rac_reason)})</span>` : "";
    return `
    <div class="detail-field">
      <span class="label">成分</span>
      <span class="value">
        ${escapeHtml(i.name)}
        ${i.density ? ` <span class="badge">${escapeHtml(i.density)}</span>` : ""}
        ${racEl}${reason}
      </span>
    </div>`;
  }).join("");

  const sortedProducts = [...g.products].sort((a, b) => {
    if ((a.status === "失効") !== (b.status === "失効")) return a.status === "失効" ? 1 : -1;
    return (a.registration_date || "").localeCompare(b.registration_date || "");
  });
  const productRows = sortedProducts.map(p => `
    <tr data-reg="${p.reg_no}" class="group-product-row ${p.status === "失効" ? 'cancelled' : ''}">
      <td>${escapeHtml(p.product_name)}</td>
      <td>${escapeHtml(p.company)}</td>
      <td>第${p.reg_no}号</td>
      <td>${escapeHtml(p.formulation || "")}</td>
      <td>${p.status === "失効"
        ? `<span class="badge status-inactive">失効</span>`
        : `<span class="badge status-active">有効</span>`}</td>
      <td>${escapeHtml(p.registration_date || "")}</td>
    </tr>
  `).join("");

  const companies = [...new Set(g.products.map(p => p.company))];
  const detailTitleMain = stripCompanyFromName(rep.product_name, rep.company);
  const showDetailType = g.type_name && g.type_name !== detailTitleMain;
  detailContent.innerHTML = `
    <div class="detail-header">
      <div>
        <h2 class="detail-title">${escapeHtml(detailTitleMain)}</h2>
        <div class="detail-title-sub">${showDetailType ? `種類: ${escapeHtml(g.type_name)} · ` : ""}${g.products.length} 商品 / ${companies.length} 社</div>
        <div class="result-meta">
          ${catBadges}
          <span class="badge" title="用途（FAMIC原表記）">${escapeHtml(rep.original_category || "")}</span>
        </div>
      </div>
      <button class="detail-close" aria-label="閉じる">✕</button>
    </div>

    <div class="detail-section">
      <h3>共通成分 (${rep.ingredients.length})</h3>
      ${ingRows}
    </div>

    <div class="detail-section">
      <h3>該当商品一覧 (${g.products.length})</h3>
      <table class="app-table group-products-table">
        <thead>
          <tr>
            <th>商品名 (登録名)</th><th>会社名</th><th>登録番号</th><th>剤型</th><th>状態</th><th>登録年月日</th>
          </tr>
        </thead>
        <tbody>${productRows}</tbody>
      </table>
      <p style="font-size:12px; color: var(--text-muted); margin: 6px 0 0;">
        行をクリックすると、その商品の適用情報 (作物・病害虫・希釈倍数等) が下に表示されます
      </p>
    </div>

    <div id="group-product-detail" class="detail-section"></div>
  `;

  detailContent.querySelector(".detail-close").addEventListener("click", closeDetail);
  detailContent.querySelectorAll(".group-product-row").forEach(row =>
    row.addEventListener("click", () => showGroupProductApplications(parseInt(row.dataset.reg, 10)))
  );
  showGroupProductApplications(initialDetailProduct(g, rep).reg_no);
}

/** 検索ボックスとサイドバーで指定した作物・病害虫から、適用表の行を絞る条件を作る */
function currentRowCondition() {
  return buildRowCondition(
    state.currentQuery, state.index && state.index.lexicon, state.searchMode,
    { crop: state.filters.crop, pest: state.filters.pest }
  );
}

/**
 * 詳細を開いたとき最初に適用表を出す商品。代表商品 (rep) が今の条件に当たる行を持たなければ、
 * 同じグループで条件に当たる行を持つ有効な商品にする (代表商品だけを見ると 0 行になる場合があるため)。
 */
function initialDetailProduct(g, rep) {
  const cond = currentRowCondition();
  if (state.appScope !== "specified" || !hasRowCondition(cond)) return rep;
  const hasRows = p => filterApplications(getApplicationsFor(p.reg_no) || [], cond).length > 0;
  if (hasRows(rep)) return rep;
  return g.products.find(p => p.status !== "失効" && hasRows(p)) || rep;
}

/**
 * 有効成分ごとの総使用回数 (例 "ダイアジノン: 2回以内")。applications.json は、どの成分の総使用回数も
 * 本剤の使用回数と同じ行の totals を省いているので、そのときは本剤の使用回数を出す。
 */
function totalUsageHtml(a, p) {
  const names = p.total_usage_names;
  if (!names || !names.length) return "";
  const totals = a.totals || names.map(() => a.count || "");
  return totals
    .map((t, i) => t ? `${escapeHtml(names[i] || "")}: ${escapeHtml(t)}` : "")
    .filter(Boolean).join("<br>");
}

/** 使用目的・適用地帯・適用土壌・くん蒸の条件 (値のあるものだけ) */
function conditionHtml(a) {
  const parts = [];
  if (a.purpose) parts.push(`使用目的: ${a.purpose}`);
  if (a.zone) parts.push(`適用地帯: ${a.zone}`);
  if (a.soil) parts.push(`適用土壌: ${a.soil}`);
  if (a.fumi_time || a.fumi_temp) parts.push(`くん蒸: ${[a.fumi_time, a.fumi_temp].filter(Boolean).join("、")}`);
  return parts.map(escapeHtml).join("<br>");
}

// 適用表の列。optional の列は、表示する行のどれにも値が無ければ出さない (スマホで表が広がりすぎないように)
const APP_COLUMNS = [
  { head: "作物名", cell: a => escapeHtml(a.crop) },
  { head: "適用場所", cell: a => escapeHtml(a.place), optional: true },
  { head: "適用病害虫雑草", cell: a => escapeHtml(a.pest) },
  { head: "希釈倍数・使用量", cell: a => escapeHtml(a.dosage) },
  { head: "散布液量", cell: a => escapeHtml(a.spray), optional: true },
  { head: "使用時期", cell: a => escapeHtml(a.timing) },
  { head: "本剤の使用回数", cell: a => escapeHtml(a.count) },
  { head: "総使用回数", cell: totalUsageHtml, optional: true },
  { head: "使用方法", cell: a => escapeHtml(a.method) },
  { head: "条件", cell: conditionHtml, optional: true },
];

function showGroupProductApplications(regNo) {
  const p = state.db.products.find(x => x.reg_no === regNo);
  const target = $("#group-product-detail");
  if (!target || !p) return;
  detailContent.querySelectorAll(".group-product-row").forEach(r => {
    r.classList.toggle("selected", parseInt(r.dataset.reg, 10) === regNo);
  });
  state.detailRegNo = regNo;
  const allApps = getApplicationsFor(regNo) || [];
  // 「指定した作物・病害虫のみ」のとき、検索ボックスとサイドバーで指定した作物・病害虫の行に絞る
  const cond = currentRowCondition();
  const narrowed = state.appScope === "specified" && hasRowCondition(cond);
  const apps = narrowed ? filterApplications(allApps, cond) : allApps;
  const condParts = [];
  if (state.filters.crop) condParts.push(`作物: ${state.filters.crop}`);
  if (state.filters.pest) condParts.push(`病害虫: ${state.filters.pest}`);
  for (const t of [...cond.crops, ...cond.pests, ...cond.either]) condParts.push(t);
  const scopeNote = narrowed
    ? `<p style="font-size:12px; color: var(--text-muted); margin: 0 0 8px;">
         指定した条件 (${escapeHtml([...new Set(condParts)].join(" / "))}) に該当する行のみを表示しています
         (${apps.length} / ${allApps.length} 行)。サイドバーの「適用情報の表示範囲」で全登録に切り替えられます。
       </p>`
    : "";
  const emptyMessage = narrowed && allApps.length > 0
    ? `指定した条件に該当する適用行はありません (全登録 ${allApps.length} 行は、サイドバーの「適用情報の表示範囲」で表示できます)`
    : `適用情報なし (失効剤には適用情報がありません)`;
  const cols = APP_COLUMNS
    .map(c => ({ head: c.head, optional: c.optional, cells: apps.map(a => c.cell(a, p)) }))
    .filter(c => !c.optional || c.cells.some(v => v && v !== "-"));  // FAMIC は値が無いことを "-" で表す
  const appTableHtml = apps.length === 0
    ? `<div class="empty" style="padding:20px;">${escapeHtml(emptyMessage)}</div>`
    : `
      <div class="app-table-wrap">
        <table class="app-table">
          <thead>
            <tr>${cols.map(c => `<th>${c.head}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${apps.map((a, i) => `<tr>${cols.map(c => `<td>${c.cells[i]}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>
    `;
  target.innerHTML = `
    <h3>${escapeHtml(p.product_name)} の適用 (${narrowed ? `${apps.length} / ${allApps.length}` : allApps.length})</h3>
    <div class="result-meta" style="margin-bottom: 8px;">
      <span>${escapeHtml(p.company)}</span><span>·</span>
      <span>第${p.reg_no}号</span><span>·</span>
      <span>${escapeHtml(p.formulation || "")}</span><span>·</span>
      <span>登録 ${escapeHtml(p.registration_date || "")}</span>
      ${p.expire_date ? `<span>·</span><span>失効 ${escapeHtml(p.expire_date)}</span>` : ""}
      ${p.household ? `<span class="badge household">家庭向け</span>` : ""}
    </div>
    ${scopeNote}
    ${appTableHtml}
    ${resistanceSectionHtml(p, apps, cond, narrowed)}
  `;
  const overseas = target.querySelector(".res-overseas-toggle");
  if (overseas) {
    overseas.addEventListener("change", e => {
      setShowOverseas(e.target.checked);
      showGroupProductApplications(regNo);
    });
  }
}

// ===== 抵抗性・耐性の報告 =====

const RES_SYS_LABEL = { I: "IRAC", F: "FRAC", H: "HRAC" };
const RES_BASIS_LABEL = {
  crop: "作物ごとの対応",
  group: "作物群の対応",
  any: "全作物に共通の対応",
  name: "病害虫名と和名が同じ種",
};
const RES_OVERSEAS_KEY = "pesticide-search:res-overseas";

// 「海外の報告を表示」は端末に覚えさせる。保存できない環境 (プライベートブラウズなど) では毎回「表示」から始める
function loadOverseasPref() {
  try {
    return localStorage.getItem(RES_OVERSEAS_KEY) !== "0";
  } catch (e) {
    return true;
  }
}

function setShowOverseas(value) {
  state.showOverseas = value;
  try {
    localStorage.setItem(RES_OVERSEAS_KEY, value ? "1" : "0");
  } catch (e) {
    // 保存できなくても、この画面を開いている間の表示は切り替わる
  }
}

function resHasOverseas(rx) {
  for (const list of rx.byTaxon.values()) if (list.some(isOverseasRecord)) return true;
  return false;
}

function resLevelBadge(level) {
  const L = RESISTANCE_LEVELS[level];
  return L ? `<span class="badge res-level res-${level}">${L.label}</span>` : "";
}

function resRegion(r) {
  if (isOverseasRecord(r)) return r.country;
  return (RES_PREFECTURES[r.pref] || [])[0] || "-";
}

function resTaxonLabel(rx, id) {
  const t = rx.taxa[id] || {};
  return `${t.ja ? `${escapeHtml(t.ja)} ` : ""}<i>${escapeHtml(t.sci || id)}</i>`;
}

function resSourceHtml(rx, r) {
  const s = r.src || {};
  const title = escapeHtml(s.title || s.url || "");
  const parts = [s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title];
  if (s.publisher) parts.push(escapeHtml(s.publisher));
  if (s.page) parts.push(escapeHtml(s.page));
  const origin = r.origin !== "domestic" && rx.sources.get(r.origin);
  if (origin) parts.push(`<span class="res-origin">${escapeHtml(origin.name)} より取り込み</span>`);
  return parts.join("<br>");
}

/**
 * 報告の表。hits は findResistance / recordsByRacCode の戻り値。
 * opts.relation: 成分の下に「同じ成分」「同じ系統」を出す、opts.taxon: 種の列を出す、opts.code: 系統の列を出す
 */
function resRecordTableHtml(rx, hits, opts = {}) {
  const heads = ["成分", opts.code && "系統", opts.taxon && "種", "程度", "地域", "年", "宿主作物", "数値・判定", "出典"].filter(Boolean);
  const rows = hits.map(h => {
    const r = h.record;
    const sys = RES_SYS_LABEL[(rx.taxa[h.taxon] || {}).sys] || "";
    const rel = h.relation === "ingredient"
      ? `<span class="res-rel res-rel-ingredient">同じ成分</span>`
      : `<span class="res-rel res-rel-group">同じ系統 (${escapeHtml(`${sys} ${h.code || ""}`.trim())})</span>`;
    const detail = [r.metric, r.wording].filter(Boolean).map(escapeHtml).join("<br>")
      + (r.note ? `<br><span class="res-muted">${escapeHtml(r.note)}</span>` : "");
    const cells = [
      `${escapeHtml(r.ingredient || r.ingredient_en || "-")}${opts.relation ? `<br>${rel}` : ""}`,
      opts.code && escapeHtml((r.rac || []).map(c => `${sys} ${c}`).join(", ") || "-"),
      opts.taxon && resTaxonLabel(rx, h.taxon),
      resLevelBadge(r.level),
      // 地域・年・宿主作物は短いので折り返さない (狭い表で 1 文字ずつ折り返して読みにくくなるため)
      `<span class="res-nowrap">${escapeHtml(resRegion(r))}</span>`,
      `<span class="res-nowrap">${escapeHtml(r.year || r.published || "")}</span>`,
      `<span class="res-nowrap">${escapeHtml(r.host || "-")}</span>`,
      detail || "-",
      resSourceHtml(rx, r),
    ].filter(c => c !== false && c !== undefined);
    return `<tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
  }).join("");
  return `
    <div class="app-table-wrap">
      <table class="app-table res-table">
        <thead><tr>${heads.map(h => `<th>${h}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function resSummaryHtml(hits) {
  const s = summarizeResistance(hits);
  if (!s.count) return "";
  const where = [s.prefs.size ? `${s.prefs.size} 都道府県` : "", s.countries.size ? `海外 ${s.countries.size} か国` : ""]
    .filter(Boolean).join("・");
  return ` ${resLevelBadge(s.maxLevel)} <span class="res-muted">${s.count} 件${where ? ` / ${where}` : ""}${s.latestYear ? ` / 最新 ${s.latestYear} 年` : ""}</span>`;
}

/**
 * 抵抗性の照合に使う作物。利用者が指定した作物 (サイドバー、または AND 検索で作物と決まった 1 語) に
 * その行が当たればそれを、当たらなければ行の作物が作物群でない 1 つの作物のときだけその作物を使う。
 * 作物群の行 (野菜類など) で作物の指定が無ければ null (全作物に共通の対応だけで種を決める)。
 */
function resistanceCropFor(a, cond) {
  const userCrop = cond.scopeCrop || (cond.mode === "and" && cond.crops.length === 1 ? cond.crops[0] : "");
  if (userCrop && entryHasCrop(appEntry(a), userCrop)) return userCrop;
  const names = expandSearchableCrops(a.crop);
  if (names.length === 1 && cropGroupMembers(names[0]).size === 0) return names[0].replace(/[(（].*$/, "");
  return null;
}

/** 照合に使った作物の表示名。サイドバーで入力した作物なら入力どおりに出す (正規化するとカタカナになるため) */
function resCropLabel(crop) {
  return state.filters.crop && normalize(state.filters.crop) === crop ? state.filters.crop : crop;
}

function resPairHtml(rx, pair, t, hits) {
  const taxa = t.taxa.length
    ? ` <span class="res-taxa">→ ${t.taxa.map(id => resTaxonLabel(rx, id)).join("、")}</span> <span class="res-muted">(${RES_BASIS_LABEL[t.basis]})</span>`
    : "";
  const head = `<div class="res-pair-head"><b>${escapeHtml(pair.cropLabel || "")}</b> × <b>${escapeHtml(pair.pest)}</b>${taxa}${resSummaryHtml(hits)}</div>`;
  let body;
  if (!t.taxa.length) {
    body = t.cropSpecific && !pair.crop
      ? `<p class="res-note">この病害虫名は作物によって病原菌・種が違います。作物を指定すると照合できます。</p>`
      : `<p class="res-note">この病害虫の病原菌・種が未登録のため、照合できません。</p>`;
  } else if (!hits.length) {
    body = `<p class="res-note">この剤の成分・系統について、収録した報告はありません。</p>`;
  } else {
    const here = hits.filter(h => h.hostMatch !== false);
    const other = hits.filter(h => h.hostMatch === false);
    const opts = { relation: true, taxon: t.taxa.length > 1 };
    body = (here.length ? resRecordTableHtml(rx, here, opts) : `<p class="res-note">この作物での報告はありません。</p>`)
      + (other.length
        ? `<details class="res-other"><summary>他の作物での報告 (同じ病原菌・種) ${other.length} 件</summary>${resRecordTableHtml(rx, other, opts)}</details>`
        : "");
  }
  return `<div class="res-pair">${head}${body}</div>`;
}

/** 照合の注意書き。withToggle なら「海外の報告を表示」も付ける (抵抗性の画面は上の入力欄に同じものがある) */
function resFootnoteHtml(rx, withToggle = true) {
  const toggle = withToggle && resHasOverseas(rx)
    ? `<label class="filter-option res-inline-option"><input type="checkbox" class="res-overseas-toggle" ${state.showOverseas ? "checked" : ""}><span>海外の報告を表示</span></label>`
    : "";
  return `
    <p class="res-footnote">
      収録した報告の範囲での照合です。報告が無いことは、抵抗性・耐性が無いことを意味しません。
      「同じ系統」は、成分は違っても作用機構の分類 (RAC コード) が同じ報告です。交差抵抗性があるとは限りません。
      各報告は出典で確かめてください。
    </p>
    ${toggle}`;
}

/**
 * 詳細の適用表の下に出す「抵抗性・耐性の報告」。表示している適用行を (作物, 病害虫) の組にまとめ、
 * 組ごとに種を決めて、商品の成分と同じ成分・同じ系統の報告を出す。
 * narrowed (指定した作物・病害虫の行だけを表示中) でなければ、報告のある組だけを出す (組が多くなるため)。
 */
function resistanceSectionHtml(p, apps, cond, narrowed) {
  const wrap = inner => `<div class="detail-section res-section"><h3>抵抗性・耐性の報告</h3>${inner}</div>`;
  if (state.resistanceError) {
    return wrap(`<p class="res-note">抵抗性データを読み込めませんでした: ${escapeHtml(state.resistanceError)}</p>`);
  }
  const rx = state.resistance;
  if (!rx || !(p.ingredients || []).length || !apps.length) return "";
  const cats = p.categories || [p.category];
  const opts = { overseas: state.showOverseas };
  const pairs = new Map();
  for (const a of apps) {
    if (!a.pest) continue;
    const crop = resistanceCropFor(a, cond);
    const key = `${crop || a.crop}\u0000${searchablePest(a.pest)}`;
    if (!pairs.has(key)) pairs.set(key, { crop, cropLabel: crop ? resCropLabel(crop) : a.crop, pest: a.pest });
  }
  const blocks = [];
  for (const pair of pairs.values()) {
    const t = resolveTaxa(rx, pair.crop, pair.pest);
    const hits = t.taxa.length ? p.ingredients.flatMap(i => findResistance(rx, t.taxa, i, cats, pair.crop, opts)) : [];
    if (narrowed || hits.length) blocks.push(resPairHtml(rx, pair, t, hits));
  }
  const MAX_PAIRS = 30;
  let inner = blocks.slice(0, MAX_PAIRS).join("");
  if (blocks.length > MAX_PAIRS) {
    inner += `<p class="res-note">ほか ${blocks.length - MAX_PAIRS} 組。作物・病害虫を指定すると絞り込めます。</p>`;
  }
  if (!blocks.length) {
    inner = `<p class="res-note">この剤の登録 (作物 × 病害虫 ${pairs.size} 組) について、収録した報告はありません。` +
      `作物・病害虫を指定すると、組ごとの照合の状況 (病原菌・種が未登録かどうか) を表示します。</p>`;
  }
  return wrap(inner + resFootnoteHtml(rx));
}

// ===== 抵抗性の画面 (作物 × 病害虫 を選んで、系統ごと・都道府県ごとの報告を見る) =====

function setView(view) {
  state.view = view;
  document.body.classList.toggle("view-resistance", view === "resistance");
  $("#resistance-panel").hidden = view !== "resistance";
  document.querySelectorAll("#view-switch button").forEach(b =>
    b.setAttribute("aria-selected", String(b.dataset.view === view)));
  if (view === "resistance") renderResistanceView();
}

/** その作物で種 taxa に当たる、適用データの病害虫名 (pestNamesForTaxa)。入力した病害虫名そのものは常に含める */
function resCoveringPests(rx, crop, pest, taxa) {
  const names = state.pestSuggestions.map(([name]) => name);
  return [...new Set([pest, ...pestNamesForTaxa(rx, crop, names, taxa)])];
}

/**
 * その作物 × 病害虫名 (pests のどれか) に登録のある有効剤を、系統 (種の RAC 系統のコード) ごとに数える。
 * 作物と病害虫の組はサイドバーの絞り込みと同じ規則 (同じ適用行に作物と病害虫がある) で見る。
 * 戻り値 Map(code → { ingredients: Map(成分名 → 剤の数), products: 剤の数 })。コードの無い成分は "" に入れる
 */
function resRegisteredGroups(crop, pests, systems) {
  const products = new Set();
  for (const pest of pests) {
    for (const p of applyFilters(state.db.products, {
      ...DEFAULT_FILTERS,
      statuses: new Set(["有効"]),
      excludeBranded: false,
      crop, pest,
    })) products.add(p);
  }
  const out = new Map();
  for (const p of products) {
    const cats = p.categories || [p.category];
    const seen = new Set();
    for (const i of p.ingredients || []) {
      const split = splitRacCode(i.rac_code, cats);
      const codes = [...systems].flatMap(s => split[s]);
      for (const code of codes.length ? codes : [""]) {
        if (!out.has(code)) out.set(code, { ingredients: new Map(), products: 0 });
        const g = out.get(code);
        g.ingredients.set(i.name, (g.ingredients.get(i.name) || 0) + 1);
        if (!seen.has(code)) { g.products++; seen.add(code); }
      }
    }
  }
  return out;
}

function resIntroHtml(rx) {
  const domestic = [...rx.byTaxon.values()].flat().filter(r => r.origin === "domestic").length;
  const external = rx.recordCount - domestic;
  // 報告のある病害虫 (病害虫名の対応の病害虫名と、報告のある種の和名) を、押すと入力される候補として出す
  const names = new Map();
  for (const [pest, entries] of rx.pestMap) {
    const n = entries.reduce((sum, e) => sum + e.taxa.reduce((s, id) => s + (rx.byTaxon.get(id) || []).length, 0), 0);
    if (n) names.set(entries[0].pest, n);
  }
  for (const [id, list] of rx.byTaxon) {
    const ja = (rx.taxa[id] || {}).ja;
    if (ja && /[ァ-ヶ]/.test(ja) && !names.has(ja)) names.set(ja, list.length);
  }
  const chips = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)
    .map(([n, c]) => `<button type="button" class="res-chip" data-pest="${escapeHtml(n)}">${escapeHtml(n)} <span class="res-muted">${c}</span></button>`)
    .join("");
  return `
    <div class="res-intro">
      <p>作物と病害虫・雑草を入れると、その組の病原菌・害虫の種を決め、登録のある剤の系統 (RAC コード) ごとに、
      どの程度の抵抗性・耐性が、どこで報告されているかを表示します。同じ病名でも作物によって病原菌が違うため、
      病気は作物を入れてください。</p>
      <p class="res-muted">収録している報告: 国内の確認済み ${domestic} 件${external ? `、外部データベース ${external} 件` : ""}。
      報告が無いことは、抵抗性が無いことを意味しません。</p>
      ${chips ? `<div class="res-chips">${chips}</div>` : `<p class="res-note">まだ報告を収録していません。</p>`}
    </div>`;
}

function resMapHtml(prefLevels, title) {
  const tiles = Object.entries(RES_PREFECTURES).map(([code, [name, x, y]]) => {
    const level = prefLevels.get(code);
    const label = level ? `${name}: ${RESISTANCE_LEVELS[level].label}` : `${name}: 報告なし`;
    return `<div class="res-tile ${level ? `res-${level}` : ""}" style="grid-column:${x + 1};grid-row:${y + 1}" title="${escapeHtml(label)}">${escapeHtml(name)}</div>`;
  }).join("");
  const legend = Object.entries(RESISTANCE_LEVELS)
    .map(([k, L]) => `<span class="res-legend-item"><span class="res-tile-swatch res-${k}"></span>${L.label}</span>`).join("")
    + `<span class="res-legend-item"><span class="res-tile-swatch"></span>報告なし</span>`;
  return `
    <div class="res-map-block">
      <div class="res-map-title">${title}</div>
      <div class="res-map" role="img" aria-label="${escapeHtml(title)}の都道府県別の地図">${tiles}</div>
      <div class="res-legend">${legend}</div>
    </div>`;
}

function renderResistanceView() {
  const body = $("#res-body");
  if (state.resistanceError) {
    body.innerHTML = `<div class="empty">抵抗性データを読み込めませんでした: ${escapeHtml(state.resistanceError)}</div>`;
    return;
  }
  const rx = state.resistance;
  if (!rx) {
    body.innerHTML = `<div class="loading">データを読込中...</div>`;
    return;
  }
  $("#res-overseas-option").hidden = !resHasOverseas(rx);
  $("#res-overseas").checked = state.showOverseas;
  const { crop, pest } = state.res;
  if (!pest) {
    body.innerHTML = resIntroHtml(rx);
    body.querySelectorAll(".res-chip").forEach(b => b.addEventListener("click", () => {
      state.res.pest = b.dataset.pest;
      $("#res-pest").value = b.dataset.pest;
      renderResistanceView();
    }));
    return;
  }

  const t = resolveTaxa(rx, crop || null, pest);
  const label = `${crop ? `${escapeHtml(crop)} × ` : ""}${escapeHtml(pest)}`;
  if (!t.taxa.length) {
    body.innerHTML = `<div class="res-intro"><p class="res-note">${label}: ${t.cropSpecific && !crop
      ? "この病害虫名は作物によって病原菌・種が違います。作物を入れてください。"
      : "この病害虫の病原菌・種が未登録のため、照合できません。"}</p></div>`;
    return;
  }

  const basisSources = [...new Set(t.entries.map(e => e.source).filter(Boolean))];
  const pests = resCoveringPests(rx, crop, pest, t.taxa);
  const otherPests = pests.filter(n => normalize(searchablePest(n)) !== normalize(searchablePest(pest)));
  let html = `
    <div class="res-taxa-block">
      <div><b>${label}</b> の病原菌・種:
        ${t.taxa.map(id => resTaxonLabel(rx, id)).join("、")}
        <span class="res-muted">(${RES_BASIS_LABEL[t.basis]}${basisSources.length ? `。根拠: ${basisSources.map(escapeHtml).join(" / ")}` : ""})</span>
      </div>
      ${otherPests.length
        ? `<div class="res-muted">登録は、同じ種に当たる病害虫名 (${otherPests.slice(0, 8).map(escapeHtml).join("、")}${otherPests.length > 8 ? " ほか" : ""}) の分も数えています。</div>` : ""}
      ${t.cropSpecific && t.basis !== "crop" && t.basis !== "group"
        ? `<div class="res-note">この病害虫名は作物によって病原菌・種が違う場合があります。作物を入れると絞り込めます。</div>` : ""}
    </div>`;

  const systems = new Set(t.taxa.map(id => rx.taxa[id].sys));
  const registered = resRegisteredGroups(crop, pests, systems);
  const byCode = recordsByRacCode(rx, t.taxa, crop || null, { overseas: state.showOverseas });
  if (state.res.hostOnly && crop) {
    for (const [code, list] of byCode) byCode.set(code, list.filter(h => h.hostMatch));
  }
  const sysLabel = [...systems].map(s => RES_SYS_LABEL[s]).join("/");
  const codes = [...new Set([...registered.keys(), ...byCode.keys()])]
    .sort((a, b) => (a === "") - (b === "") || a.localeCompare(b, "ja", { numeric: true }));
  if (state.res.code !== null && !codes.includes(state.res.code)) state.res.code = null;

  const rows = codes.map(code => {
    const reg = registered.get(code);
    const hits = byCode.get(code) || [];
    const s = summarizeResistance(hits);
    const ings = reg ? [...reg.ingredients.keys()].slice(0, 6).map(escapeHtml).join("、") + (reg.ingredients.size > 6 ? " ほか" : "") : "";
    const prefs = [...s.prefs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pc, lv]) => `<span class="res-pref res-${lv}">${escapeHtml(RES_PREFECTURES[pc][0])}</span>`).join("")
      + [...s.countries].map(c => `<span class="res-pref res-country">${escapeHtml(c)}</span>`).join("");
    const selected = state.res.code === code;
    return `
      <tr class="res-code-row ${selected ? "selected" : ""}" data-code="${escapeHtml(code)}">
        <td><b>${code ? `${sysLabel} ${escapeHtml(code)}` : "系統なし・不明"}</b></td>
        <td>${reg ? `${reg.products} 剤<br><span class="res-muted">${ings}</span>` : `<span class="res-muted">登録なし</span>`}</td>
        <td>${s.count ? resLevelBadge(s.maxLevel) : `<span class="res-muted">報告なし</span>`}</td>
        <td>${prefs || "-"}</td>
        <td>${s.latestYear || "-"}</td>
        <td>${s.count || "-"}</td>
      </tr>`;
  }).join("");
  html += `
    <div class="detail-section">
      <h3>系統ごとの報告 (行を押すと、その系統の地図と報告を表示)</h3>
      <div class="app-table-wrap">
        <table class="app-table res-code-table">
          <thead><tr><th>系統</th><th>登録のある剤 (有効)</th><th>最も強い程度</th><th>報告のある地域</th><th>最新の年</th><th>報告数</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  // 選んだ系統 (選んでいなければ全系統) の地図と報告の一覧
  const code = state.res.code;
  const seen = new Set();
  const hits = (code === null ? [...byCode.values()].flat() : byCode.get(code) || [])
    .filter(h => !seen.has(h.record.id) && seen.add(h.record.id));
  const s = summarizeResistance(hits);
  const scopeLabel = code === null ? "全系統" : code ? `${sysLabel} ${escapeHtml(code)}` : "系統なし・不明";
  html += `<div class="detail-section res-map-section">
    ${resMapHtml(s.prefs, `${label}: ${scopeLabel}`)}
    ${s.countries.size ? `<p class="res-muted">海外: ${[...s.countries].map(escapeHtml).join("、")}</p>` : ""}
    ${code ? pests.slice(0, 4).map(n => `<button type="button" class="res-search-btn" data-code="${escapeHtml(code)}" data-pest="${escapeHtml(n)}">この系統の剤を「剤を探す」で一覧する${pests.length > 1 ? ` (${escapeHtml(n)})` : ""}</button>`).join(" ") : ""}
  </div>`;
  html += `<div class="detail-section"><h3>報告 (${scopeLabel}、${hits.length} 件)</h3>
    ${hits.length ? resRecordTableHtml(rx, hits, { code: true, taxon: t.taxa.length > 1 }) : `<p class="res-note">収録した報告はありません。</p>`}
    ${resFootnoteHtml(rx, false)}
  </div>`;

  body.innerHTML = html;
  body.querySelectorAll(".res-code-row").forEach(row => row.addEventListener("click", () => {
    state.res.code = state.res.code === row.dataset.code ? null : row.dataset.code;
    renderResistanceView();
  }));
  body.querySelectorAll(".res-search-btn").forEach(btn => btn.addEventListener("click", () =>
    searchByRacCode(crop, btn.dataset.pest, [...systems][0], btn.dataset.code)));
}

/** 「剤を探す」に切り替え、作物・病害虫をサイドバーに、系統を検索語に入れて一覧する */
function searchByRacCode(crop, pest, sys, code) {
  state.filters.crop = crop;
  state.filters.pest = pest;
  $("#filter-crop").value = crop;
  $("#filter-pest").value = pest;
  state.currentQuery = `${RES_SYS_LABEL[sys]} ${code}`;
  searchInput.value = state.currentQuery;
  setView("search");
  updateResults();
}

function closeDetail() {
  detailOverlay.classList.remove("open");
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let debounceTimer = null;
searchInput.addEventListener("input", e => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.currentQuery = e.target.value;
    updateResults();
  }, 150);
});

// AND / OR 検索モード切替 (検索バー横のセグメントトグル)
document.querySelectorAll("#search-mode input[name='search-mode']").forEach(rb => {
  rb.checked = rb.value === state.searchMode;
  rb.addEventListener("change", e => {
    if (!e.target.checked) return;
    state.searchMode = e.target.value;
    updateResults();
  });
});

// 適用情報の表示範囲 (指定した作物・病害虫のみ / 剤の登録すべて)
document.querySelectorAll("#filter-app-scope input[name='app-scope']").forEach(rb => {
  rb.checked = rb.value === state.appScope;
  rb.addEventListener("change", e => {
    if (!e.target.checked) return;
    state.appScope = e.target.value;
    if (state.detailRegNo != null && detailOverlay.classList.contains("open")) {
      showGroupProductApplications(state.detailRegNo);
    }
  });
});

detailOverlay.addEventListener("click", e => {
  if (e.target === detailOverlay) closeDetail();
});

// 画面の切り替え (剤を探す / 抵抗性を見る)
document.querySelectorAll("#view-switch button").forEach(b =>
  b.addEventListener("click", () => setView(b.dataset.view))
);

// 抵抗性の画面の入力。待ち時間の間にもう一方の欄を打っても取りこぼさないよう、描き直すときに両方の欄を読む
let resDebounce = null;
for (const id of ["#res-crop", "#res-pest"]) {
  $(id).addEventListener("input", () => {
    clearTimeout(resDebounce);
    resDebounce = setTimeout(() => {
      state.res.crop = $("#res-crop").value.trim();
      state.res.pest = $("#res-pest").value.trim();
      state.res.code = null;
      renderResistanceView();
    }, 200);
  });
}
$("#res-host-only").addEventListener("change", e => {
  state.res.hostOnly = e.target.checked;
  renderResistanceView();
});
$("#res-overseas").addEventListener("change", e => {
  setShowOverseas(e.target.checked);
  renderResistanceView();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeDetail();
  if (e.key === "/" && e.target !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
});

$("#export-tsv").addEventListener("click", () =>
  download(`pesticides_${new Date().toISOString().slice(0,10)}.tsv`, exportTSV(state.currentResults), "text/tab-separated-values")
);
$("#export-csv").addEventListener("click", () =>
  download(`pesticides_${new Date().toISOString().slice(0,10)}.csv`, exportCSV(state.currentResults), "text/csv")
);
$("#export-md").addEventListener("click", () =>
  download(`pesticides_${new Date().toISOString().slice(0,10)}.md`, exportMarkdown(state.currentResults), "text/markdown")
);
$("#export-json").addEventListener("click", () =>
  download(`pesticides_${new Date().toISOString().slice(0,10)}.json`, exportJSON(state.currentResults), "application/json")
);

init();

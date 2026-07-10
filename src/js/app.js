/**
 * 農薬検索アプリ メインエントリ
 */

import { buildIndex, search } from "./core/search.js";
import { applyFilters, DEFAULT_FILTERS, countFormulations } from "./core/filter.js";
import { normalize, expandSearchableCrops, splitRacCode, stripCompanyFromName } from "./core/normalize.js";
import { exportTSV, exportCSV, exportMarkdown, exportJSON, download } from "./io/export.js";
import { loadApplications, getApplicationsFor } from "./io/applications.js";

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
  racSystem: null, // null=自動(全系統) | "I"|"F"|"H" = IRAC/FRAC/HRAC に限定
  currentResults: [],
  currentGroups: [],
  selectedFormulations: null,
  cropSuggestions: [],
  pestSuggestions: [],
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
    attachCropsPests(state.db.products, apps);
    state.index = buildIndex(state.db.products, apps);
    renderHeader();
    renderFilters();
    updateResults();
  } catch (e) {
    resultList.innerHTML = `<div class="empty">データ読込エラー: ${e.message}<br><small>scripts/build_data.py を実行してから再試行してください。</small></div>`;
    console.error(e);
  }
}

function attachCropsPests(products, applications) {
  const cropCount = new Map();
  const pestCount = new Map();
  for (const p of products) {
    const entries = applications[String(p.reg_no)] || [];
    const crops = new Set();
    const pests = new Set();
    // 適用行ごとに作物欄・病害虫欄を分離保持 (作物×病害虫 同時指定時の共起判定用)
    const pairs = [];
    for (const a of entries) {
      const cparts = [];
      if (a.crop) {
        for (const expanded of expandSearchableCrops(a.crop)) {
          const n = normalize(expanded);
          crops.add(n);
          cparts.push(n);
        }
        cropCount.set(a.crop, (cropCount.get(a.crop) || 0) + 1);
      }
      if (a.place) {
        for (const expanded of expandSearchableCrops(a.place)) {
          const n = normalize(expanded);
          crops.add(n);
          cparts.push(n);
        }
      }
      const pestNorm = a.pest ? normalize(a.pest) : "";
      if (pestNorm) {
        pests.add(pestNorm);
        pestCount.set(a.pest, (pestCount.get(a.pest) || 0) + 1);
      }
      pairs.push({ crop: cparts.join("|"), pest: pestNorm });
    }
    p._crops_norm = [...crops].join("|");
    p._pests_norm = [...pests].join("|");
    p._app_pairs = pairs;
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

  $("#filter-mix").checked = state.filters.mixOnly;
  $("#filter-mix").addEventListener("change", e => {
    state.filters.mixOnly = e.target.checked;
    updateResults();
  });

  const formDiv = $("#filter-formulations");
  const forms = countFormulations(state.db.products);
  formDiv.innerHTML = `<option value="">全て (${state.db.products.length})</option>` +
    [...forms.entries()].slice(0, 50)
      .map(([name, cnt]) => `<option value="${name}">${name} (${cnt})</option>`).join("");
  formDiv.addEventListener("change", e => {
    const v = e.target.value;
    state.filters.formulations = v ? new Set([v]) : null;
    updateResults();
  });

  const cropList = $("#crop-suggestions");
  if (cropList && state.cropSuggestions) {
    cropList.innerHTML = state.cropSuggestions
      .slice(0, 1500)
      .map(([name, cnt]) => `<option value="${name.replaceAll('"', '&quot;')}">${cnt} 件</option>`)
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
      .map(([name, cnt]) => `<option value="${name.replaceAll('"', '&quot;')}">${cnt} 件</option>`)
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
  let results = search(state.currentQuery, state.index, state.racSystem, state.searchMode);
  results = applyFilters(results, state.filters);
  state.currentResults = results;
  state.currentGroups = groupByTypeName(results);
  renderResults(state.currentGroups, results.length);
}

function groupByTypeName(products) {
  const map = new Map();
  for (const p of products) {
    const key = p.type_name || p.product_name;
    let g = map.get(key);
    if (!g) {
      g = { type_name: key, products: [] };
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
    card.addEventListener("click", () => openGroupDetail(card.dataset.tname))
  );
}

function renderGroupCard(g) {
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
  const catBadges = cats.map(c => `<span class="badge category-${c}">${c}</span>`).join(" ");
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
  const sigSet = new Set(g.products.map(p => p.ingredients.map(i => i.name).sort().join("|")));
  const ingNote = sigSet.size > 1
    ? ` <span class="badge ingredient-variant" title="この種類名内に ${sigSet.size} パターンの成分構成が含まれます">成分${sigSet.size}変種</span>`
    : "";
  const titleMain = stripCompanyFromName(rep.product_name, rep.company);
  const showTypeSub = g.type_name && g.type_name !== titleMain;
  const subParts = [];
  if (showTypeSub) subParts.push(`種類: ${escapeHtml(g.type_name)}`);
  subParts.push(`${g.products.length} 商品 / ${companies.length} 社`);
  return `
    <div class="result-card group-card ${isAllCancelled ? 'cancelled' : ''}" data-tname="${escapeHtml(g.type_name)}">
      <div class="result-header">
        <div class="result-title">${escapeHtml(titleMain)}<span class="result-title-sub">${subParts.join(" · ")}</span></div>
        <span>${catBadges} ${statusBadge}</span>
      </div>
      <div class="result-meta">
        <span>${escapeHtml(companyText)}</span>
        ${formText ? `<span>·</span><span>${escapeHtml(formText)}</span>` : ""}
      </div>
      <div class="result-ingredients">${ingBadges}${ingNote}</div>
    </div>
  `;
}

async function openGroupDetail(typeName) {
  const g = state.currentGroups.find(x => x.type_name === typeName);
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
  showGroupProductApplications(rep.reg_no);
}

function showGroupProductApplications(regNo) {
  const p = state.db.products.find(x => x.reg_no === regNo);
  const target = $("#group-product-detail");
  if (!target || !p) return;
  detailContent.querySelectorAll(".group-product-row").forEach(r => {
    r.classList.toggle("selected", parseInt(r.dataset.reg, 10) === regNo);
  });
  const apps = getApplicationsFor(regNo) || [];
  const appTableHtml = apps.length === 0
    ? `<div class="empty" style="padding:20px;">適用情報なし (失効剤には適用情報がありません)</div>`
    : `
      <table class="app-table">
        <thead>
          <tr>
            <th>作物名</th><th>適用病害虫雑草</th><th>希釈/使用量</th><th>使用時期</th><th>使用回数</th><th>使用方法</th>
          </tr>
        </thead>
        <tbody>
          ${apps.map(a => `
            <tr>
              <td>${escapeHtml(a.crop)}</td>
              <td>${escapeHtml(a.pest)}</td>
              <td>${escapeHtml(a.dosage)}</td>
              <td>${escapeHtml(a.timing)}</td>
              <td>${escapeHtml(a.count)}</td>
              <td>${escapeHtml(a.method)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  target.innerHTML = `
    <h3>${escapeHtml(p.product_name)} の適用 (${apps.length})</h3>
    <div class="result-meta" style="margin-bottom: 8px;">
      <span>${escapeHtml(p.company)}</span><span>·</span>
      <span>第${p.reg_no}号</span><span>·</span>
      <span>${escapeHtml(p.formulation || "")}</span><span>·</span>
      <span>登録 ${escapeHtml(p.registration_date || "")}</span>
      ${p.expire_date ? `<span>·</span><span>失効 ${escapeHtml(p.expire_date)}</span>` : ""}
      ${p.household ? `<span class="badge household">家庭向け</span>` : ""}
    </div>
    ${appTableHtml}
  `;
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

detailOverlay.addEventListener("click", e => {
  if (e.target === detailOverlay) closeDetail();
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

/**
 * 農薬検索アプリ メインエントリ
 */

import { buildIndex, search } from "./core/search.js";
import { applyFilters, DEFAULT_FILTERS, countFormulations } from "./core/filter.js";
import { normalize } from "./core/normalize.js";
import { exportTSV, exportCSV, exportMarkdown, exportJSON, download } from "./io/export.js";
import { loadApplications, getApplicationsFor } from "./io/applications.js";

// RAC ステータスの表示ラベル (rac_manual.json と対応)
const RAC_STATUS_LABEL = {
  out_of_scope: "対象外",
  legacy: "古典未分類",
  recent: "新規未収録",
};

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
  currentResults: [],
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
      // 開発版: fetch
      const res = await fetch("data/pesticides.json");
      state.db = await res.json();
    } else {
      state.db = dbRaw;
    }

    // 適用部 (作物・病害虫) を先に読み込み、検索インデックスとフィルタに含める
    // バンドル版は window.APPLICATIONS から瞬時にロード、開発版は fetch
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

/**
 * 各商品に _crops_norm / _pests_norm (正規化済み pipe 結合文字列) を付与。
 * filter.applyFilters で部分一致判定するため。
 * 副産物として、出現頻度順の作物名/病害虫名の配列もサイドバー datalist 用に生成。
 */
function attachCropsPests(products, applications) {
  const cropCount = new Map();
  const pestCount = new Map();
  for (const p of products) {
    const entries = applications[String(p.reg_no)] || [];
    const crops = new Set();
    const pests = new Set();
    for (const a of entries) {
      if (a.crop) {
        crops.add(normalize(a.crop));
        cropCount.set(a.crop, (cropCount.get(a.crop) || 0) + 1);
      }
      if (a.place) crops.add(normalize(a.place));
      if (a.pest) {
        pests.add(normalize(a.pest));
        pestCount.set(a.pest, (pestCount.get(a.pest) || 0) + 1);
      }
    }
    p._crops_norm = [...crops].join("|");
    p._pests_norm = [...pests].join("|");
  }
  state.cropSuggestions = [...cropCount.entries()].sort((a, b) => b[1] - a[1]);
  state.pestSuggestions = [...pestCount.entries()].sort((a, b) => b[1] - a[1]);
}

function toReiwa(dateStr) {
  // "2026-04-08" → "令和8年4月8日"、"2025-06" → "令和7年6月"
  if (!dateStr) return "";
  const m = String(dateStr).match(/(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return dateStr;
  const y = parseInt(m[1], 10);
  const mo = m[2] ? parseInt(m[2], 10) : null;
  const d = m[3] ? parseInt(m[3], 10) : null;
  // 令和は 2019-05-01 開始（令和元年=2019）
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
  // カテゴリ (殺虫殺菌剤は両方にカウント)
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

  // 登録状態
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

  // 家庭向け除外
  $("#filter-household").checked = state.filters.excludeHousehold;
  $("#filter-household").addEventListener("change", e => {
    state.filters.excludeHousehold = e.target.checked;
    updateResults();
  });

  // 混合剤のみ
  $("#filter-mix").checked = state.filters.mixOnly;
  $("#filter-mix").addEventListener("change", e => {
    state.filters.mixOnly = e.target.checked;
    updateResults();
  });

  // 剤型
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

  // 作物 + 病害虫/雑草 (datalist で autocomplete)
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
  let results = search(state.currentQuery, state.index);
  results = applyFilters(results, state.filters);
  state.currentResults = results;
  renderResults(results);
}

function renderResults(results) {
  resultCount.textContent = `${results.length.toLocaleString()} 件`;
  if (results.length === 0) {
    resultList.innerHTML = `<div class="empty">該当する剤がありません。</div>`;
    return;
  }
  const MAX = 500;
  const shown = results.slice(0, MAX);
  resultList.innerHTML = shown.map(renderCard).join("");
  if (results.length > MAX) {
    resultList.innerHTML += `<div class="empty" style="padding:20px;">上位 ${MAX} 件を表示。絞り込みで件数を減らしてください。</div>`;
  }
  resultList.querySelectorAll(".result-card").forEach(card =>
    card.addEventListener("click", () => openDetail(parseInt(card.dataset.reg, 10)))
  );
}

function renderCard(p) {
  const ingBadges = p.ingredients.map(i => {
    const racBadge = i.rac_code
      ? ` <span class="badge rac">${i.rac_code}</span>`
      : (i.rac_status ? ` <span class="badge rac-${i.rac_status}" title="${escapeHtml(i.rac_reason || '')}">${RAC_STATUS_LABEL[i.rac_status] || '未分類'}</span>` : "");
    return `<span class="badge ingredient">${escapeHtml(i.name)}${racBadge}</span>`;
  }).join("");
  const householdBadge = p.household ? `<span class="badge household">家庭向け</span>` : "";
  const cats = p.categories || [p.category];
  const catBadges = cats.map(c => `<span class="badge category-${c}">${c}</span>`).join(" ");
  const isCancelled = p.status === "失効";
  const statusBadge = isCancelled
    ? `<span class="badge status-inactive">失効 ${escapeHtml(p.expire_date || "")}</span>`
    : `<span class="badge status-active">有効</span>`;
  return `
    <div class="result-card ${isCancelled ? 'cancelled' : ''}" data-reg="${p.reg_no}">
      <div class="result-header">
        <div class="result-title">${escapeHtml(p.product_name)}</div>
        <span>${catBadges} ${statusBadge}</span>
      </div>
      <div class="result-meta">
        <span>${escapeHtml(p.company)}</span>
        ${p.formulation ? `<span>·</span><span>${escapeHtml(p.formulation)}</span>` : ""}
        <span>·</span>
        <span>第${p.reg_no}号</span>
        <span>·</span>
        <span>登録 ${escapeHtml(p.registration_date || "")}</span>
        ${householdBadge}
      </div>
      <div class="result-ingredients">${ingBadges}</div>
    </div>
  `;
}

async function openDetail(regNo) {
  const p = state.db.products.find(x => x.reg_no === regNo);
  if (!p) return;

  detailOverlay.classList.add("open");
  detailContent.innerHTML = `<div class="loading">適用情報を読込中...</div>`;

  // 適用部を読込
  await loadApplications();
  const apps = getApplicationsFor(regNo) || [];

  const ingRows = p.ingredients.map(i => {
    let racEl = "";
    if (i.rac_code) {
      racEl = ` <span class="badge rac">${escapeHtml(i.rac_code)}</span>`;
    } else if (i.rac_status) {
      const label = RAC_STATUS_LABEL[i.rac_status] || "未分類";
      const reason = i.rac_reason ? ` <span class="rac-reason">(${escapeHtml(i.rac_reason)})</span>` : "";
      racEl = ` <span class="badge rac-${i.rac_status}" title="${escapeHtml(i.rac_reason || '')}">${label}</span>${reason}`;
    }
    return `
    <div class="detail-field">
      <span class="label">成分</span>
      <span class="value">
        ${escapeHtml(i.name)}
        ${i.density ? ` <span class="badge">${escapeHtml(i.density)}</span>` : ""}
        ${racEl}
      </span>
    </div>`;
  }).join("");
  const appTableHtml = apps.length === 0
    ? `<div class="empty" style="padding:20px;">適用情報なし</div>`
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

  const detailCats = (p.categories || [p.category])
    .map(c => `<span class="badge category-${c}">${c}</span>`).join(" ");
  detailContent.innerHTML = `
    <div class="detail-header">
      <div>
        <h2 class="detail-title">${escapeHtml(p.product_name)}</h2>
        <div class="result-meta">
          ${detailCats}
          <span class="badge" title="用途（FAMIC原表記）">${escapeHtml(p.original_category || "")}</span>
          <span>${escapeHtml(p.company)}</span>
          <span>·</span>
          <span>第${p.reg_no}号</span>
          <span>·</span>
          <span>${escapeHtml(p.formulation)}</span>
          ${p.household ? `<span class="badge household">家庭向け</span>` : ""}
        </div>
      </div>
      <button class="detail-close" aria-label="閉じる">✕</button>
    </div>

    <div class="detail-section">
      <h3>基本情報</h3>
      <div class="detail-field"><span class="label">種類</span><span class="value">${escapeHtml(p.type_name)}</span></div>
      <div class="detail-field"><span class="label">登録状態</span><span class="value">${
        p.status === "失効"
          ? `<span class="badge status-inactive">失効</span>`
          : `<span class="badge status-active">有効</span>`
      }</span></div>
      <div class="detail-field"><span class="label">登録年月日</span><span class="value">${escapeHtml(p.registration_date || "")}</span></div>
      ${p.expire_date ? `<div class="detail-field"><span class="label">失効年月日</span><span class="value">${escapeHtml(p.expire_date)}</span></div>` : ""}
      ${p.expire_reason ? `<div class="detail-field"><span class="label">失効理由</span><span class="value">${escapeHtml(p.expire_reason)}</span></div>` : ""}
      <div class="detail-field"><span class="label">混合数</span><span class="value">${p.mix_count}</span></div>
    </div>

    <div class="detail-section">
      <h3>有効成分 (${p.ingredients.length})</h3>
      ${ingRows}
    </div>

    <div class="detail-section">
      <h3>適用 (${apps.length})</h3>
      ${appTableHtml}
    </div>
  `;

  detailContent.querySelector(".detail-close").addEventListener("click", closeDetail);
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

// イベント登録
let debounceTimer = null;
searchInput.addEventListener("input", e => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.currentQuery = e.target.value;
    updateResults();
  }, 150);
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

// エクスポート
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

#!/usr/bin/env node
// ============================================================================
// scrape-pick.js — Lay ket qua Mega 6/45 va Power 6/55 tu lottolyzer.com,
// xuat ra data/pick.json de app fetch qua raw.githubusercontent.com.
// Chay boi cung workflow voi scrape-xsmn.js (xem .github/workflows/update-xsmn.yml).
// ============================================================================

const fs = require("fs");
const path = require("path");

const GAMES = [
  { key: "mega645", slug: "vietnam/mega-645", pickCount: 6, hasBonus: false },
  { key: "power655", slug: "vietnam/power-6_slash_55", pickCount: 6, hasBonus: true },
];

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/&nbsp;/g, " ");
}

// Parse bang HTML dang <table>...<tr><td>..</td>...</tr>...</table> — lay tung hang <tr>,
// bung ra danh sach cell van ban (<td>) cua hang do. Khong flatten toan bo van ban thanh 1 dong
// (khac voi stripTags cua app) de KHONG mat ranh gioi tung hang — moi <tr> luon la 1 ky quay rieng.
function extractTableRows(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const rowHtml = m[1];
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = tdRe.exec(rowHtml))) {
      const text = cm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

async function fetchPage(slug, page) {
  const url = "https://en.lottolyzer.com/history/" + slug + "/page/" + page + "/per-page/50/summary-view";
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.text();
}

// Cot: Draw | Date | Winning No. | [Bonus] | From Last | Sum | ...
// Chi lay 3-4 cot dau, bo qua phan con lai.
function parseDrawRows(rows, game) {
  const draws = [];
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  rows.forEach(function (cells) {
    if (cells.length < 3) return;
    const dateCell = cells[1];
    if (!dateRe.test(dateCell)) return; // bo qua hang tieu de / hang khong dung dinh dang
    const numsCell = cells[2];
    const nums = numsCell.split(",").map(function (s) { return parseInt(s.trim(), 10); })
      .filter(function (n) { return Number.isInteger(n); });
    if (nums.length !== game.pickCount) return;
    let bonus = null;
    if (game.hasBonus) {
      const b = parseInt((cells[3] || "").trim(), 10);
      if (Number.isInteger(b)) bonus = b;
    }
    draws.push({ date: dateCell, numbers: nums.sort(function (a, b) { return a - b; }), bonus: bonus });
  });
  return draws;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function isoOf(d) { return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Trang 1 (50 ky moi nhat) la du cho cap nhat hang ngay. Nhung neu du lieu da co (existingArr)
// CHUA lui toi 01/01 nam hien tai (vd lan dau chay, hoac bi gian doan lau ngay), thi lay THEM cac
// trang tiep theo (2, 3, ...) — Lottolyzer sap xep moi nhat truoc nen trang sau la ky CU HON — cho
// den khi da phu toi dau nam, het du lieu, hoac cham tran an toan MAX_PAGES (tranh quet vo han).
const MAX_PAGES = 8; // 8 trang x 50 = toi da 400 ky — du sau cho ca nam ke ca game quay 3 lan/tuan
async function scrapeGame(game, existingArr) {
  const todayIso = isoOf(new Date());
  const yearStartIso = todayIso.slice(0, 4) + "-01-01";
  const existingDates = new Set((existingArr || []).map(function (r) { return r[0]; }));
  const earliestExisting = existingDates.size > 0 ? Array.from(existingDates).sort()[0] : null;
  const needsBackfill = !earliestExisting || earliestExisting > yearStartIso;

  const allDraws = [];
  let page = 1;
  let pagesFetched = 0;
  while (page <= MAX_PAGES) {
    const html = await fetchPage(game.slug, page);
    pagesFetched++;
    const text = stripTags(html);
    const rows = extractTableRows(text);
    const draws = parseDrawRows(rows, game);
    if (draws.length === 0) break; // het du lieu (qua trang cuoi) — dung lai
    allDraws.push.apply(allDraws, draws);
    if (!needsBackfill) break; // trang 1 la du cho cap nhat thuong ngay, khong can quet them
    const oldestOnPage = draws.reduce(function (m, d) { return !m || d.date < m ? d.date : m; }, null);
    if (oldestOnPage && oldestOnPage <= yearStartIso) break; // da lui toi dau nam — du roi
    page++;
    await sleep(800);
  }
  return { draws: allDraws, pagesFetched: pagesFetched, backfilled: needsBackfill && pagesFetched > 1 };
}

async function main() {
  const outPath = path.join(__dirname, "data", "pick.json");
  let existing = {};
  if (fs.existsSync(outPath)) {
    try { existing = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch (e) { existing = {}; }
  }
  const result = Object.assign({}, existing);
  const summary = [];

  for (const game of GAMES) {
    try {
      const existingArr = Array.isArray(result[game.key]) ? result[game.key] : [];
      const scraped = await scrapeGame(game, existingArr);
      const existingDates = new Set(existingArr.map(function (r) { return r[0]; }));
      let added = 0;
      scraped.draws.forEach(function (d) {
        if (existingDates.has(d.date)) return;
        const row = game.hasBonus ? [d.date, d.numbers, d.bonus] : [d.date, d.numbers];
        existingArr.push(row);
        existingDates.add(d.date);
        added++;
      });
      existingArr.sort(function (a, b) { return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; });
      result[game.key] = existingArr;
      summary.push(game.key + ": +" + added + " ky moi (tong " + existingArr.length + ")" +
        (scraped.backfilled ? " [bo sung qua " + scraped.pagesFetched + " trang]" : ""));
    } catch (e) {
      summary.push(game.key + ": LOI - " + e.message);
    }
    await new Promise(function (r) { setTimeout(r, 800); });
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 0));
  console.log("=== TOM TAT (pick) ===");
  console.log(summary.join("\n"));
  console.log("Da ghi: " + outPath);
}

module.exports = { stripTags, extractTableRows, parseDrawRows, GAMES, scrapeGame };

if (require.main === module) {
  main().catch(function (e) {
    console.error("Loi khong xu ly duoc:", e);
    process.exit(1);
  });
}

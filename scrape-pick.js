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

async function scrapeGame(game) {
  // Trang 1 (50 ky moi nhat) la du cho cap nhat hang ngay — khong can quet nhieu trang.
  const html = await fetchPage(game.slug, 1);
  const text = stripTags(html);
  const rows = extractTableRows(text);
  return parseDrawRows(rows, game);
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
      const draws = await scrapeGame(game);
      const existingArr = Array.isArray(result[game.key]) ? result[game.key] : [];
      const existingDates = new Set(existingArr.map(function (r) { return r[0]; }));
      let added = 0;
      draws.forEach(function (d) {
        if (existingDates.has(d.date)) return;
        const row = game.hasBonus ? [d.date, d.numbers, d.bonus] : [d.date, d.numbers];
        existingArr.push(row);
        existingDates.add(d.date);
        added++;
      });
      existingArr.sort(function (a, b) { return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; });
      result[game.key] = existingArr;
      summary.push(game.key + ": +" + added + " ky moi (tong " + existingArr.length + ")");
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

module.exports = { stripTags, extractTableRows, parseDrawRows, GAMES };

if (require.main === module) {
  main().catch(function (e) {
    console.error("Loi khong xu ly duoc:", e);
    process.exit(1);
  });
}

#!/usr/bin/env node
// ============================================================================
// scrape-xsmn.js — Lay ket qua XSMN (21 tinh) tu minhngoc.net, xuat ra 1 file
// JSON duy nhat (data/xsmn.json) de app "vietlott_thongke.html" fetch qua
// raw.githubusercontent.com (co san header CORS Access-Control-Allow-Origin: *,
// nen trinh duyet fetch thang duoc, KHONG can proxy).
//
// Chay boi GitHub Actions theo lich (xem .github/workflows/update-xsmn.yml).
// Khong dung thu vien ngoai — chi dung fetch co san cua Node 18+.
// ============================================================================

const fs = require("fs");
const path = require("path");

const PROVINCES_MN = [
  "tp-hcm","dong-thap","ca-mau","ben-tre","vung-tau","bac-lieu","dong-nai",
  "can-tho","soc-trang","tay-ninh","an-giang","binh-thuan","vinh-long",
  "binh-duong","tra-vinh","long-an","binh-phuoc","hau-giang","tien-giang",
  "kien-giang","da-lat",
];

// Cau truc hang giai: [ten_hang, so_luong_chuoi, do_rong_moi_chuoi] — GIONG HET app.
const MT_STRUCTURE = [
  ["db", 1, 6], ["nhat", 1, 5], ["nhi", 1, 5], ["ba", 2, 5], ["tu", 7, 5],
  ["nam", 1, 4], ["sau", 3, 4], ["bay", 1, 3], ["g8", 1, 2],
];

const TIER_LABELS = [
  ["db", /gi[aả]i\s*đ[ạa]c\s*bi[eệ]t|gi[aả]i\s*đb(?![a-záàảã])/i],
  ["nhat", /gi[aả]i\s*nh[aấ]t(?![a-záàảã])/i],
  ["nhi", /gi[aả]i\s*nh[iì](?![a-záàảã])/i],
  ["ba", /gi[aả]i\s*ba(?![a-záàảã])/i],
  ["tu", /gi[aả]i\s*t[uư](?![a-záàảã])/i],
  ["nam", /gi[aả]i\s*n[aă]m(?![a-záàảã])/i],
  ["sau", /gi[aả]i\s*s[aá]u(?![a-záàảã])/i],
  ["bay", /gi[aả]i\s*b[aả]y(?![a-záàảã])/i],
  ["g8", /gi[aả]i\s*(8|t[aá]m)(?![a-záàảã])/i],
];
const TIER_WIDTH_MAP = {};
MT_STRUCTURE.forEach(function (t) { TIER_WIDTH_MAP[t[0]] = t[1] * t[2]; });

function pad2(n) { return String(n).padStart(2, "0"); }

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

function extractDatesWithPositions(text) {
  const found = [];
  const re1 = /(\d{4})-(\d{2})-(\d{2})/g;
  let m;
  while ((m = re1.exec(text))) found.push({ date: m[0], index: m.index, end: m.index + m[0].length });
  const re2 = /(\d{1,2})\/(\d{1,2})\/(\d{4})/g;
  while ((m = re2.exec(text))) {
    const iso = m[3] + "-" + pad2(+m[2]) + "-" + pad2(+m[1]);
    found.push({ date: iso, index: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

function sliceTiers(blobByTier, structure) {
  const lo = [];
  const full = {};
  const errs = [];
  structure.forEach(function (t) {
    const key = t[0], count = t[1], width = t[2];
    const blob = blobByTier[key];
    if (blob === undefined) return;
    if (blob.length !== count * width) {
      errs.push("Giai '" + key + "' ky vong " + (count * width) + " chu so, nhan " + blob.length);
      return;
    }
    const arr = [];
    for (let i = 0; i < count; i++) {
      const chunk = blob.slice(i * width, (i + 1) * width);
      arr.push(chunk);
      lo.push(parseInt(chunk.slice(-2), 10));
    }
    full[key] = arr;
  });
  return { lo, full, errs };
}

// QUAN TRONG: stripTags() gop TOAN BO khoang trang (ke ca xuong dong \n) thanh 1 dau cach —
// nen KHONG THE tach theo dong (\n) nhu truoc day (tung lam ca trang bi coi la "1 dong" duy nhat,
// khien nhan giai dau tien "nuot" het chu so cua ca cac hang giai/ky quay phia sau).
// Thay vao do: tim VI TRI xuat hien cua tung nhan giai trong toan bo doan text, roi lay chu so
// nam GIUA nhan hien tai va nhan KE TIEP (theo vi tri, khong theo dong) — sau do CAT DUNG do dai
// ky vong cua hang giai do (vd Giai 8 = 2 chu so) de bo qua phan du thua "ron" sang doan sau.
function parseLoBlockFromText(text, structure) {
  const labelHits = [];
  TIER_LABELS.forEach(function (pair) {
    const key = pair[0], re = pair[1];
    const flags = re.flags.indexOf("g") >= 0 ? re.flags : re.flags + "g";
    const globalRe = new RegExp(re.source, flags);
    let m;
    while ((m = globalRe.exec(text))) {
      labelHits.push({ key: key, start: m.index, end: m.index + m[0].length });
    }
  });
  if (labelHits.length === 0) return [];
  labelHits.sort(function (a, b) { return a.start - b.start; });

  const widthMap = {};
  structure.forEach(function (t) { widthMap[t[0]] = t[1] * t[2]; });

  const blocks = [];
  let cur = null;
  labelHits.forEach(function (hit, i) {
    if (hit.key === "db") { if (cur) blocks.push(cur); cur = {}; }
    if (!cur) return;
    const nextStart = i + 1 < labelHits.length ? labelHits[i + 1].start : text.length;
    const windowText = text.slice(hit.end, nextStart);
    let digits = (windowText.match(/\d+/g) || []).join("");
    const expectedLen = widthMap[hit.key];
    if (expectedLen && digits.length > expectedLen) digits = digits.slice(0, expectedLen);
    if (!(hit.key in cur)) cur[hit.key] = digits;
  });
  if (cur) blocks.push(cur);

  const results = [];
  blocks.forEach(function (b) {
    const r = sliceTiers(b, structure);
    if (r.lo.length > 0 && r.errs.length === 0) results.push(r);
  });
  return results;
}

function mergeFullTiers(target, addition) {
  Object.keys(addition || {}).forEach(function (key) {
    if (!target[key]) target[key] = [];
    target[key] = target[key].concat(addition[key]);
  });
  return target;
}

function parseLoDrawsFromText(text, structure) {
  const dates = extractDatesWithPositions(text);
  if (dates.length === 0) return [];
  const draws = [];
  for (let i = 0; i < dates.length; i++) {
    const start = dates[i].end;
    const end = i + 1 < dates.length ? dates[i + 1].index : text.length;
    const segment = text.slice(start, end);
    const blocks = parseLoBlockFromText(segment, structure);
    if (blocks.length === 0) continue;
    let merged = [];
    let mergedFull = {};
    blocks.forEach(function (b) { merged = merged.concat(b.lo); mergedFull = mergeFullTiers(mergedFull, b.full); });
    if (merged.length === 18) {
      draws.push({ date: dates[i].date, numbers: merged, full: mergedFull });
    }
  }
  // Nhieu doan co the trung ngay (vd nhan ngay xuat hien o link phan trang truoc bang ket qua that)
  // — giu lai BAN DAU TIEN co du 18 so cho moi ngay (thuong la ban dung, cac ban trung sau la noise).
  const seen = {};
  const uniqueDraws = [];
  draws.forEach(function (d) {
    if (seen[d.date]) return;
    seen[d.date] = true;
    uniqueDraws.push(d);
  });
  return uniqueDraws;
}

async function fetchProvincePage(slug) {
  const url = "https://www.minhngoc.net/ket-qua-xo-so/mien-nam/" + slug + ".html";
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
      "Referer": "https://www.minhngoc.net/",
    },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.text();
}

async function main() {
  const outPath = path.join(__dirname, "data", "xsmn.json");
  let existing = {};
  if (fs.existsSync(outPath)) {
    try { existing = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch (e) { existing = {}; }
  }

  const result = Object.assign({}, existing);
  const summary = [];
  let debugPrinted = 0; // chi in debug cho 2 tinh dau tien bi 0 ky, tranh log qua dai

  for (const slug of PROVINCES_MN) {
    try {
      const html = await fetchProvincePage(slug);
      const text = stripTags(html);
      const draws = parseLoDrawsFromText(text, MT_STRUCTURE);
      if (draws.length === 0 && debugPrinted < 2) {
        debugPrinted++;
        console.log("--- DEBUG " + slug + ": html.length=" + html.length + " ---");
        console.log("Co chua 'Giai DB'/'Giai Dac Biet' khong: " + /gi[aả]i\s*đ[ạa]c\s*bi[eệ]t|gi[aả]i\s*đb/i.test(text));
        console.log("Co chua ngay dang DD/MM/YYYY khong: " + /\d{1,2}\/\d{1,2}\/\d{4}/.test(text));
        console.log("Co chua chuoi '2026' khong: " + text.includes("2026"));
        const idx2026 = text.indexOf("2026");
        if (idx2026 >= 0) {
          console.log("Ngu canh quanh '2026' dau tien (100 ky tu truoc/sau): " + text.slice(Math.max(0, idx2026 - 100), idx2026 + 100));
        }
        const idxKq = text.toLowerCase().indexOf("ket qua");
        if (idxKq >= 0) {
          console.log("Ngu canh quanh 'ket qua' dau tien: " + text.slice(idxKq, idxKq + 400));
        }
        console.log("Text cuoi (200 ky tu cuoi): " + text.slice(-200));
      }
      const existingArr = Array.isArray(result[slug]) ? result[slug] : [];
      const existingDates = new Set(existingArr.map((r) => r[0]));
      let added = 0;
      draws.forEach(function (d) {
        if (existingDates.has(d.date)) return;
        existingArr.push([d.date, d.numbers, d.full]);
        existingDates.add(d.date);
        added++;
      });
      // Sap xep moi nhat truoc, giong quy uoc trong app.
      existingArr.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
      result[slug] = existingArr;
      summary.push(slug + ": +" + added + " ky moi (tong " + existingArr.length + ")");
    } catch (e) {
      summary.push(slug + ": LOI - " + e.message);
    }
    // Nghi 1 chut giua cac request de lich su voi server nguon.
    await new Promise((r) => setTimeout(r, 800));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 0));
  console.log("=== TOM TAT ===");
  console.log(summary.join("\n"));
  console.log("Da ghi: " + outPath);
}

module.exports = { stripTags, extractDatesWithPositions, sliceTiers, parseLoBlockFromText, parseLoDrawsFromText, MT_STRUCTURE, PROVINCES_MN };

if (require.main === module) {
  main().catch(function (e) {
    console.error("Loi khong xu ly duoc:", e);
    process.exit(1);
  });
}

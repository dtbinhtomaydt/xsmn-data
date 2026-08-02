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

// Trang nguon ma hoa 1 so chu co dau (nhung chu TRUNG voi bang HTML4 chuan, vd à á ì) thanh
// HTML entity (vd "nh&igrave;" thay vi "nhì") thay vi ky tu UTF-8 truc tiep — can giai ma truoc
// khi so khop nhan giai, neu khong "nhì"/"sáu" se khong duoc nhan dien.
const NAMED_ENTITIES = {
  amp:"&", lt:"<", gt:">", quot:'"', apos:"'", nbsp:" ", copy:"©", reg:"®", trade:"™",
  hellip:"…", mdash:"—", ndash:"–", lsquo:"‘", rsquo:"’", ldquo:"“", rdquo:"”",
  deg:"°", middot:"·", laquo:"«", raquo:"»", sect:"§", para:"¶", bull:"•",
  agrave:"à", aacute:"á", acirc:"â", atilde:"ã", auml:"ä", aring:"å", aelig:"æ",
  ccedil:"ç", egrave:"è", eacute:"é", ecirc:"ê", euml:"ë",
  igrave:"ì", iacute:"í", icirc:"î", iuml:"ï", ntilde:"ñ",
  ograve:"ò", oacute:"ó", ocirc:"ô", otilde:"õ", ouml:"ö", oslash:"ø",
  ugrave:"ù", uacute:"ú", ucirc:"û", uuml:"ü", yacute:"ý", yuml:"ÿ",
  Agrave:"À", Aacute:"Á", Acirc:"Â", Atilde:"Ã", Auml:"Ä", Aring:"Å", AElig:"Æ",
  Ccedil:"Ç", Egrave:"È", Eacute:"É", Ecirc:"Ê", Euml:"Ë",
  Igrave:"Ì", Iacute:"Í", Icirc:"Î", Iuml:"Ï", Ntilde:"Ñ",
  Ograve:"Ò", Oacute:"Ó", Ocirc:"Ô", Otilde:"Õ", Ouml:"Ö", Oslash:"Ø",
  Ugrave:"Ù", Uacute:"Ú", Ucirc:"Û", Uuml:"Ü", Yacute:"Ý",
  eth:"ð", ETH:"Ð", thorn:"þ", THORN:"Þ", szlig:"ß",
};
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&([a-zA-Z]+);/g, function (m, name) { return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m; });
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    // QUAN TRONG: trang nguon co the tra ve chu tieng Viet o dang to hop dau rieng (Unicode NFD,
    // vd "a" + dau hoi rieng) thay vi dang dung san (NFC, vd "ả" la 1 ky tu). Cac regex nhan dien
    // nhan giai (TIER_LABELS) duoc viet theo dang NFC nen se KHONG khop duoc voi van ban NFD —
    // chuan hoa ve NFC truoc de dam bao khop dung trong moi truong hop.
    .normalize("NFC");
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
        // Debug sau: chay lai chinh xac tung buoc cua parseLoDrawsFromText de xem doan (segment)
        // nao duoc xet va co bao nhieu nhan giai duoc tim thay trong DUNG doan do.
        const dbgDates = extractDatesWithPositions(text);
        console.log("So luong 'ngay' tim thay tren toan trang: " + dbgDates.length);
        console.log("5 ngay dau tien: " + JSON.stringify(dbgDates.slice(0, 5).map(function(d){return d.date+"@"+d.index;})));
        for (let di = 0; di < Math.min(3, dbgDates.length); di++) {
          const segStart = dbgDates[di].end;
          const segEnd = di + 1 < dbgDates.length ? dbgDates[di + 1].index : text.length;
          const segment = text.slice(segStart, segEnd);
          console.log("--- Segment #" + di + " (ngay=" + dbgDates[di].date + ", do dai=" + segment.length + ") ---");
          console.log("Noi dung segment (toi da 300 ky tu): " + segment.slice(0, 300));
          const dbgHits = [];
          TIER_LABELS.forEach(function (pair) {
            const key = pair[0], re = pair[1];
            const flags = re.flags.indexOf("g") >= 0 ? re.flags : re.flags + "g";
            const globalRe = new RegExp(re.source, flags);
            let mm;
            while ((mm = globalRe.exec(segment))) dbgHits.push(key + "@" + mm.index);
          });
          console.log("Nhan giai tim thay trong segment nay: " + JSON.stringify(dbgHits));
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

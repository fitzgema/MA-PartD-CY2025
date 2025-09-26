// scripts/resolve_sb_urls.mjs
// Auto-discovers Summary of Benefits (SB) PDF URLs for each MA plan using SerpAPI (Google JSON wrapper).
import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import pdf from "pdf-parse";
import pLimit from "p-limit";

const YEARS = (process.env.TARGET_YEARS || "2025")
  .split(",").map(s => Number(s.trim())).filter(Boolean);

const OUT_AUTO_DIR = path.resolve("dist/benefits/auto");
await fs.mkdir(OUT_AUTO_DIR, { recursive: true });

const SERPAPI_KEY = process.env.SERPAPI_KEY;
if (!SERPAPI_KEY) {
  console.log("[WARN] SERPAPI_KEY not set; skipping auto discovery.");
  for (const y of YEARS) {
    await fs.writeFile(path.join(OUT_AUTO_DIR, `${y}_sources.csv`), "cmsPlanKey,orgName,marketingName,url\n");
    await fs.writeFile(path.join(OUT_AUTO_DIR, `missing_${y}.json`), JSON.stringify([], null, 2));
  }
  process.exit(0);
}

const limit = pLimit(Number(process.env.SB_DISCOVERY_CONCURRENCY || 2));
const UA = "MyNutritionAdvisorBot/1.0 (+support@mynutritionadvisor.ai)";

/* ---------- helpers ---------- */
function toKey({year, contractId, planId, segmentId}) {
  const seg = (segmentId || "000").toString().padStart(3, "0");
  return `${year}-${contractId.toUpperCase()}-${String(planId).padStart(3,"0")}-${seg}`;
}
function uniquePlans(arr) {
  const seen = new Set(), out = [];
  for (const p of arr) {
    const k = toKey(p);
    if (!seen.has(k)) { seen.add(k); out.push({...p, cmsPlanKey:k}); }
  }
  return out;
}
function planRegex(contractId, planId, year) {
  const cp = contractId.replace(/[-\s]/g, "") + "\\s*[- ]?\\s*" + String(planId).padStart(3,"0");
  return { cp: new RegExp(cp, "i"), yr: new RegExp(String(year), "i"), sob: /summary\s+of\s+benefits/i };
}
async function serpapi(query, num=10) {
  // Google results via SerpAPI
  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("q", query);
  u.searchParams.set("num", String(num));
  u.searchParams.set("engine", "google");
  u.searchParams.set("api_key", SERPAPI_KEY);
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`SerpAPI HTTP ${r.status}`);
  const j = await r.json();
  const items = j.organic_results || [];
  // prefer .pdf links; include sitelinks if present
  const urls = [];
  for (const it of items) {
    if (it.link) urls.push(it.link);
    if (Array.isArray(it.sitelinks)) it.sitelinks.forEach(s => s.link && urls.push(s.link));
    if (it.rich_snippet?.top?.extensions) {
      // ignore
    }
  }
  // de-dupe
  return Array.from(new Set(urls));
}
async function fetchPdfToText(url, maxBytes=10*1024*1024) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!r.ok) return null;
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("pdf") && !url.toLowerCase().endsWith(".pdf")) return null;
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab.slice(0, maxBytes));
  try { const parsed = await pdf(buf); return parsed.text || ""; } catch { return null; }
}

/* ---------- load distinct plans from previous MA build ---------- */
async function collectPlansForYear(y) {
  const byCountyDir = path.resolve(`dist/years/${y}/by-county`);
  let files = [];
  try { files = await fs.readdir(byCountyDir); } catch { return []; }
  const plans = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const j = JSON.parse(await fs.readFile(path.join(byCountyDir, f), "utf8"));
    for (const c of j.carriers || []) {
      for (const p of c.plans || []) {
        if (!p.contractId || !p.planId) continue;
        plans.push({
          year: y,
          contractId: p.contractId,
          planId: p.planId,
          segmentId: p.segmentId || "000",
          orgName: c.orgName || p.contractId,
          marketingName: p.marketingName || ""
        });
      }
    }
  }
  return uniquePlans(plans);
}

function buildQueries(plan) {
  const { year, contractId, planId, orgName, marketingName } = plan;
  const cp = `${contractId}-${String(planId).padStart(3,"0")}`;
  const q1 = `"Summary of Benefits" ${year} ${cp} filetype:pdf`;
  const q2 = `"Summary of Benefits" ${year} ${contractId} ${String(planId).padStart(3,"0")} "${orgName}" filetype:pdf`;
  const q3 = marketingName ? `"Summary of Benefits" ${year} "${marketingName}" filetype:pdf` : null;
  return [q1, q2, q3].filter(Boolean);
}

async function resolveOne(plan) {
  const { year, contractId, planId } = plan;
  const { cp, yr, sob } = planRegex(contractId, planId, year);
  const queries = buildQueries(plan);

  for (const q of queries) {
    let urls = [];
    try { urls = await serpapi(q, 20); } catch { urls = []; }
    // prefer direct pdfs, but also allow carrier pages linking directly to pdf
    const pdfFirst = urls.filter(u => u.toLowerCase().includes(".pdf"))
                         .concat(urls.filter(u => !u.toLowerCase().includes(".pdf")));
    for (const url of pdfFirst) {
      try {
        const text = await fetchPdfToText(url);
        if (!text) continue;
        if (sob.test(text) && cp.test(text) && yr.test(text)) {
          return url; // verified PDF
        }
      } catch { /* keep trying */ }
    }
  }
  return null;
}

/* ---------- main ---------- */
for (const y of YEARS) {
  const plans = await collectPlansForYear(y);
  console.log(`[AUTO] ${y}: unique plans found = ${plans.length}`);

  const rows = [];
  const missing = [];
  const tasks = plans.map(p => limit(async () => {
    const url = await resolveOne(p);
    if (url) {
      rows.push(`${p.cmsPlanKey},${csv(p.orgName)},${csv(p.marketingName)},${csv(url)}`);
      console.log(`[FOUND] ${p.cmsPlanKey} ← ${url}`);
    } else {
      missing.push(p);
      console.log(`[MISS]  ${p.cmsPlanKey}`);
    }
  }));

  await Promise.all(tasks);

  rows.sort();
  const header = "cmsPlanKey,orgName,marketingName,url\n";
  await fs.writeFile(path.join(OUT_AUTO_DIR, `${y}_sources.csv`), header + rows.join("\n") + (rows.length? "\n" : ""));
  await fs.writeFile(path.join(OUT_AUTO_DIR, `missing_${y}.json`), JSON.stringify(missing, null, 2));
  console.log(`[AUTO] ${y}: resolved=${rows.length} missing=${missing.length} → dist/benefits/auto/`);
}

function csv(s) {
  if (s == null) return "";
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

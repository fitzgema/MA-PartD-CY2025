// scripts/build_ma_benefits.mjs
import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import { parse as parseCsv } from "csv-parse/sync";
import pLimit from "p-limit";
import { pdfBufferToText } from "./_pdf_text.js";

const OUT_DIR = path.resolve("dist/benefits");
await fs.mkdir(path.join(OUT_DIR, "by-plan"), { recursive: true });

const YEARS = (process.env.TARGET_YEARS || "2025")
  .split(",").map(s => Number(s.trim())).filter(Boolean);

const limit = pLimit(4);

// ---- read sources from BOTH manual csv and auto csv ----
function readText(p) {
  try { return require("fs").readFileSync(p, "utf8"); } catch { return ""; }
}
function readSourcesForYear(y) {
  const out = new Map(); // cmsPlanKey -> record
  const paths = [
    path.resolve(`data/benefits/${y}_sources.csv`),
    path.resolve(`dist/benefits/auto/${y}_sources.csv`)
  ];
  for (const p of paths) {
    const raw = readText(p);
    if (!raw) continue;
    const rows = parseCsv(raw, { columns: true, skip_empty_lines: true });
    for (const r of rows) {
      const key = (r.cmsPlanKey || "").trim();
      const url = (r.url || "").trim();
      if (!key || !url) continue;
      if (!out.has(key)) {
        out.set(key, {
          year: y,
          cmsPlanKey: key,
          orgName: r.orgName || "",
          marketingName: r.marketingName || "",
          url
        });
      }
    }
  }
  return Array.from(out.values());
}

// ---- main ----
const allSources = [];
for (const y of YEARS) allSources.push(...readSourcesForYear(y));

if (allSources.length === 0) {
  console.log("[INFO] No benefits sources -> writing empty index and exiting.");
  await fs.writeFile(path.join(OUT_DIR, "plan-index.json"), JSON.stringify([], null, 2));
  process.exit(0);
}

const results = await Promise.all(allSources.map(src => limit(() => processOne(src))));
const good = results.filter(Boolean);

await fs.writeFile(
  path.join(OUT_DIR, "plan-index.json"),
  JSON.stringify(
    good.map(r => ({
      cmsPlanKey: r.cmsPlanKey,
      orgName: r.planMeta.orgName,
      marketingName: r.planMeta.marketingName,
      year: Number(r.cmsPlanKey.slice(0,4)),
      sourcePdfUrl: r.sourcePdfUrl,
      extractedAt: new Date().toISOString()
    })),
    null, 2
  )
);

console.log(`[DONE] Benefits generated for ${good.length}/${allSources.length} plans → dist/benefits`);

async function processOne({ cmsPlanKey, orgName, marketingName, url }) {
  try {
    console.log(`[BENEFITS] ${cmsPlanKey} ← ${url}`);
    const buf = await fetchPdf(url);
    const text = await pdfBufferToText(buf);   // ← PDF.js helper
    const normalized = normalize(text);

    const medical = extractMedical(normalized);
    const nutrition = extractNutrition(normalized);
    const supplemental = extractSupplemental(normalized);

    const out = {
      cmsPlanKey,
      sourcePdfUrl: url,
      planMeta: { orgName, marketingName },
      medical, nutrition, supplemental
    };
    await fs.writeFile(path.join(OUT_DIR, "by-plan", `${cmsPlanKey}.json`), JSON.stringify(out, null, 2));
    return out;
  } catch (err) {
    console.error(`[ERROR] ${cmsPlanKey}: ${err.message}`);
    return null;
  }
}

async function fetchPdf(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 BenefitsBot/1.0" }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error("Empty PDF");
  return buf;
}

// ---------- text helpers & extractors ----------
function normalize(txt) {
  const t = txt.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  const lines = t.split("\n").map(s => s.trim()).filter(Boolean);
  const lower = lines.map(l => l.toLowerCase());
  return { lines, lower };
}
function findNearby(n, pattern, radius = 4) {
  for (let i = 0; i < n.lower.length; i++) {
    if (pattern.test(n.lower[i])) {
      const snippet = n.lines.slice(Math.max(0, i - radius), Math.min(n.lines.length, i + radius + 1)).join(" ");
      return { text: snippet };
    }
  }
  return null;
}
function moneyFrom(s) {
  const m = s.match(/\$ ?(\d{1,3}(?:,\d{3})*)(?:\.(\d{2}))?/);
  if (!m) return null;
  const amt = Number(m[1].replace(/,/g, "")) + (m[2] ? Number(`0.${m[2]}`) : 0);
  return amt;
}
function periodFrom(s) {
  if (/per month|monthly|each month/i.test(s)) return "month";
  if (/per quarter|quarterly|every 3 months/i.test(s)) return "quarter";
  if (/per year|annually|each year/i.test(s)) return "year";
  if (/per week|weekly/i.test(s)) return "week";
  return null;
}
function hasCoveredWord(hit) {
  if (!hit) return null;
  const s = hit.text.toLowerCase();
  if (/no charge|\$0|zero|covered/.test(s)) return true;
  if (/not covered|no coverage/.test(s)) return false;
  return null;
}
function extractMoneyWithPeriod(n, pattern) {
  const hit = findNearby(n, pattern, 6);
  if (!hit) return null;
  return { amount: moneyFrom(hit.text) ?? null, period: periodFrom(hit.text), text: hit.text };
}
function findLineValue(n, pattern) {
  for (let i = 0; i < n.lower.length; i++) {
    if (pattern.test(n.lower[i])) {
      const text = n.lines[i];
      const amount = moneyFrom(text);
      return { text, amount };
    }
  }
  return null;
}
function extractMedical(n) {
  const pcp = findLineValue(n, /(primary care|pcp)[^$%]*\b(visit|office|telehealth)?/);
  const spec = findLineValue(n, /(specialist)[^$%]*\b(visit|office|telehealth)?/);
  const tele = n.lower.some(l => /telehealth|virtual visit|virtual care/.test(l));
  const referral = n.lower.some(l => /referral required/.test(l)) && !n.lower.some(l => /no referral/.test(l));
  return {
    primaryCareCopayText: pcp?.text ?? null,
    primaryCareCopay: pcp?.amount ?? null,
    specialistCopayText: spec?.text ?? null,
    specialistCopay: spec?.amount ?? null,
    telehealthPrimary: tele || null,
    referralRequired: referral || false
  };
}
function extractNutrition(n) {
  const mntLine = findNearby(n, /(medical )?nutrition therapy|[^a-z]mnt[^a-z]/i);
  const obesityLine = findNearby(n, /obesity (counseling|therapy)|ibt|intensive behavioral/i);
  const dietitianLine = findNearby(n, /dietitian|registered dietitian|rdn/i);
  return {
    mntCovered: hasCoveredWord(mntLine),
    mntText: mntLine?.text ?? null,
    obesityCounselingCovered: hasCoveredWord(obesityLine),
    obesityCounselingText: obesityLine?.text ?? null,
    dietitianCopayText: dietitianLine?.text ?? null,
    visitLimitsText: findNearby(n, /visit limit|visits per year|maximum visits|limits/i)?.text ?? null
  };
}
function extractSupplemental(n) {
  const otc = extractMoneyWithPeriod(n, /(over[- ]?the[- ]?counter|[^a-z]otc[^a-z]|otc allowance|otc benefit)/i);
  const food = extractMoneyWithPeriod(n, /(healthy (foods?|food) (card|allowance)|grocery|food benefit)/i);
  const mealsPd = extractMeals(n, /(post[- ]?discharge|transitional|after hospital)/i);
  const mealsCh = extractMeals(n, /(chronic|condition|recurring)/i);
  const fitness = findProgram(n, /(silversneakers|renew active|silver ?& ?fit|one pass|active ?& ?fit|gym)/i);
  const transport = extractTrips(n, /(transportation|rides)/i);
  return { otcAllowance: otc, healthyFoodCard: food, postDischargeMeals: mealsPd, chronicMeals: mealsCh, fitness, transportation: transport };
}
function extractMeals(n, pattern) {
  const hit = findNearby(n, pattern, 5);
  if (!hit) return null;
  const m = hit.text.match(/(\d{1,3})\s*meals?/i);
  const meals = m ? Number(m[1]) : null;
  const ep = /per (episode|discharge|stay|hospitalization)/i.test(hit.text) ? "episode" : null;
  const per = /per month|monthly/i.test(hit.text) ? "month" : ep;
  return { meals, period: per, text: hit.text };
}
function findProgram(n, pattern) {
  const hit = findNearby(n, pattern, 3);
  if (!hit) return null;
  const name = (hit.text.match(/SilverSneakers|Renew Active|Silver ?& ?Fit|One Pass|Active ?& ?Fit/i) || [null])[0];
  return { program: name, text: hit.text };
}
function extractTrips(n, pattern) {
  const hit = findNearby(n, pattern, 4);
  if (!hit) return null;
  const m = hit.text.match(/(\d{1,3})\s*(?:one[- ]way )?(?:trips|rides)/i);
  const trips = m ? Number(m[1]) : null;
  const period = periodFrom(hit.text) || "year";
  return { trips, period, text: hit.text };
}

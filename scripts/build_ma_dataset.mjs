// scripts/build_ma_dataset.mjs
import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import AdmZip from "adm-zip";
import { parse as parseCsv } from "csv-parse/sync";
import * as XLSX from "xlsx";

const OUT_DIR = path.resolve("dist");
const YEARS = (process.env.TARGET_YEARS || "2025")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter(Boolean);

const CMS_URL = process.env.CMS_LANDSCAPE_URL; // e.g. https://www.cms.gov/files/zip/cy2025-landscape-202506.1.zip
if (!CMS_URL) {
  console.error("Missing CMS_LANDSCAPE_URL secret (direct link to CMS Landscape zip).");
  process.exit(1);
}

// Census ZCTA->County (2020) relationship file (public, no login)
const ZCTA_COUNTY_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt";
// Census Gazetteer (2020) for county FIPS resolution by state+name
const GAZ_BASE =
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer";
const STATES = [
  "01","02","04","05","06","08","09","10","11","12","13","15","16","17","18","19","20","21",
  "22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39",
  "40","41","42","44","45","46","47","48","49","50","51","53","54","55","56","72" // include PR
];

// Clean out and (re)create dist
await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

// 1) Download CMS Landscape ZIP
const cmsZipPath = path.resolve("cms_landscape.zip");
await downloadFile(CMS_URL, cmsZipPath);

// 2) Load Landscape rows from the correct file in the ZIP
const { rows, sourceName } = await loadLandscapeRows(cmsZipPath);
console.log(`[INFO] Using CMS file inside ZIP: ${sourceName}`);
console.log(`[INFO] Total rows loaded: ${rows.length}`);

// 3) Build county FIPS lookup (if CSV lacks an explicit county FIPS)
const countyFipsMap = await buildCountyFipsMap();

// 4) Build ZCTA->County index (for the ZIP entry point)
const zipIndex = await buildZipIndex();

// 5) Process each target year
for (const year of YEARS) {
  const yearDir = path.join(OUT_DIR, "years", String(year));
  await fs.mkdir(path.join(yearDir, "by-county"), { recursive: true });

  // --- Detect headers once (robust to label changes) ---
  const yearKey = keyFromHeader(rows[0], ["Contract Year", "contract year", "Year"]);
  const contractKey = keyFromHeader(rows[0], ["Contract ID", "Contract Number", "contract id", "contract number"]);
  const planKey = keyFromHeader(rows[0], ["Plan ID", "plan id"]);
  const segmentKey = keyFromHeader(rows[0], ["Segment ID", "segment id"]); // ← NEW
  const fipsKey = keyFromHeader(rows[0], ["County FIPS", "County Code (FIPS)", "County Code", "County FIPS Code"]);
  const stateKey = keyFromHeader(rows[0], ["State Abbreviation", "State Code", "State"]);
  const countyNameKey = keyFromHeader(rows[0], ["County Name"]);
  const orgNameKey = keyFromHeader(rows[0], ["Organization Marketing Name", "Parent Organization Name"]);
  const planNameKey = keyFromHeader(rows[0], ["Plan Name"]);
  const planTypeKey = keyFromHeader(rows[0], ["Plan Type"]);
  const snpTypeKey = keyFromHeader(rows[0], ["SNP Type", "Special Needs Plan (SNP) Indicator"]);

  if (!yearKey || !contractKey || !planKey) {
    console.error("[ERROR] Could not resolve critical headers:", { yearKey, contractKey, planKey });
    console.error("[ERROR] Row0 headers:", Object.keys(rows[0]));
    process.exit(1);
  }

  // --- Filter to this year and MA by Contract ID prefix (H or R) ---
  const yrRows = rows.filter((r) => {
    const cyRaw = String(r[yearKey] ?? "");
    const cyNum = Number((cyRaw.match(/\d{4}/) || [])[0]); // extract 4-digit year anywhere in the cell
    const cid = String(r[contractKey] ?? "").trim().toUpperCase();
    const isMA = cid.startsWith("H") || cid.startsWith("R"); // MA / MA-PD
    return cyNum === year && isMA;
  });
  console.log(`[INFO] Year ${year}: MA rows: ${yrRows.length}`);

  const carriersByCounty = new Map(); // county_fips -> {state, county_name, carriers: Map}

  for (const r of yrRows) {
    // 1) County FIPS (direct if present)
    let countyFips = cleanFips(pick(r, [fipsKey]));
    if (!countyFips) {
      // Handle values like "06075 - San Francisco County"
      const raw = String(pick(r, [fipsKey]) || "");
      const m = raw.match(/(\d{5})/);
      if (m) countyFips = m[1];
    }

    // 2) If still missing, resolve via state + county name
    const state = String(pick(r, [stateKey]) || "").trim();
    const countyName = String(pick(r, [countyNameKey]) || "").trim();
    if (!countyFips) {
      if (!state || !countyName) continue; // insufficient info
      countyFips = countyFipsMap.get(keyCounty(state, countyName));
      if (!countyFips) continue; // couldn't resolve
    }

    // Contract/plan + org fields
    const contractId = String(pick(r, [contractKey]) || "").trim();
    const planId = String(pick(r, [planKey]) || "").trim();
    if (!contractId || !planId) continue;

    const segmentId = String(pick(r, [segmentKey]) ?? "").trim() || "000"; // ← NEW (default to 000)
    const orgName = (String(pick(r, [orgNameKey]) || "").trim()) || contractId;
    const marketingName = String(pick(r, [planNameKey]) || "").trim();
    const planType = (String(pick(r, [planTypeKey]) || "").trim()) || null;
    const snpType = ((String(pick(r, [snpTypeKey]) || "").trim()) || null) ?? null;

    // Bucket carriers by county
    let bucket = carriersByCounty.get(countyFips);
    if (!bucket) {
      bucket = {
        county_fips: countyFips,
        state,
        county_name: countyName || "(Unknown)",
        carriers: new Map()
      };
      carriersByCounty.set(countyFips, bucket);
    }

    const key = orgName || contractId;

    let carrier = bucket.carriers.get(key);
    if (!carrier) {
      carrier = { orgName: key, contractIds: new Set(), plans: [] };
      bucket.carriers.set(key, carrier);
    }
    carrier.contractIds.add(contractId);

    // Include segmentId in output
    carrier.plans.push({ contractId, planId, segmentId, marketingName, planType, snpType });
  }

  // Write per-county files + county index
  const countyIndex = [];
  for (const [fips, bucket] of carriersByCounty.entries()) {
    const carriers = Array.from(bucket.carriers.values()).map((c) => ({
      orgName: c.orgName,
      contractIds: Array.from(c.contractIds),
      plans: c.plans.slice(0, 20) // cap to keep files small
    }));
    const out = {
      year,
      county_fips: fips,
      state: bucket.state,
      county_name: bucket.county_name,
      carriers
    };
    await fs.writeFile(
      path.join(yearDir, "by-county", `${fips}.json`),
      JSON.stringify(out, null, 2)
    );
    countyIndex.push({ fips, state: bucket.state, name: bucket.county_name });
  }
  countyIndex.sort((a, b) => a.fips.localeCompare(b.fips));
  await fs.writeFile(
    path.join(yearDir, "county-index.json"),
    JSON.stringify(countyIndex, null, 2)
  );

  // Write ZIP index
  await fs.writeFile(
    path.join(yearDir, "zip-index.json"),
    JSON.stringify(zipIndex, null, 2)
  );
}

// copy aliases if present
try {
  await fs.copyFile("data/aliases.json", path.join(OUT_DIR, "aliases.json"));
} catch {
  /* noop */
}

console.log("Build complete. See ./dist");

/* ---------------- helpers ---------------- */

function keyFromHeader(row0, candidates) {
  if (!row0) return undefined;
  const keys = Object.keys(row0);
  for (const want of candidates) {
    const hit = keys.find(
      (k) => k.trim().toLowerCase() === String(want).trim().toLowerCase()
    );
    if (hit) return hit;
  }
  return undefined;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (!k) continue;
    if (Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return undefined;
}

function cleanFips(v) {
  if (!v && v !== 0) return undefined;
  const s = String(v).replace(/\D/g, "");
  if (!s) return undefined;
  return s.padStart(5, "0");
}

function keyCounty(stateAbbr, countyName) {
  return `${String(stateAbbr).trim().toUpperCase()}::${normalizeCountyName(countyName)}`;
}

// Normalize county name (remove LSADs)
function normalizeCountyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/county|parish|borough|census area|city and borough|municipality|independent city/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadLandscapeRows(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  // 1) try CSVs first: find a CSV that has at least YEAR + (CONTRACT & PLAN) + COUNTY info
  const csvCandidates = entries.filter((e) => e.entryName.toLowerCase().endsWith(".csv"));
  for (const e of csvCandidates) {
    const buf = e.getData();
    const txt = buf.toString("utf8");
    let rows;
    try {
      rows = parseCsv(txt, { columns: true, skip_empty_lines: true });
    } catch {
      continue;
    }
    if (rows.length === 0) continue;
    const headers = Object.keys(rows[0]).map((h) => h.trim().toLowerCase());
    const hasYear = headers.includes("contract year") || headers.includes("year");
    const hasCounty =
      headers.includes("county name") ||
      headers.includes("county fips") ||
      headers.includes("county code") ||
      headers.includes("county code (fips)");
    const hasContract =
      headers.includes("contract id") || headers.includes("contract number");
    const hasPlan = headers.includes("plan id");
    if (hasYear && hasCounty && hasContract && hasPlan) {
      return { rows, sourceName: e.entryName };
    }
  }

  // 2) fall back to XLSX if no good CSV
  const xlsxEntry = entries.find((e) => e.entryName.toLowerCase().endsWith(".xlsx"));
  if (xlsxEntry) {
    const wb = XLSX.read(xlsxEntry.getData(), { type: "buffer" });
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (!json.length) continue;
      const headers = Object.keys(json[0]).map((h) => String(h).trim().toLowerCase());
      const hasYear = headers.includes("contract year") || headers.includes("year");
      const hasCounty =
        headers.includes("county name") ||
        headers.includes("county fips") ||
        headers.includes("county code") ||
        headers.includes("county code (fips)");
      const hasContract =
        headers.includes("contract id") || headers.includes("contract number");
      const hasPlan = headers.includes("plan id");
      if (hasYear && hasCounty && hasContract && hasPlan) {
        return { rows: json, sourceName: `${xlsxEntry.entryName}#${sheetName}` };
      }
    }
  }

  throw new Error("Could not find a Landscape table with required columns in the CMS ZIP.");
}

async function buildCountyFipsMap() {
  const map = new Map();
  for (const st of STATES) {
    const url = `${GAZ_BASE}/2020_gaz_counties_${st}.txt`;
    const txt = await fetchText(url);
    // TSV: USPS | GEOID | ANSICODE | NAME | ... LSAD | ...
    const lines = txt.split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.startsWith("USPS")) continue;
      const parts = line.split("\t");
      const usps = parts[0];
      const geoid = parts[1];
      const name = parts[3]; // county name with LSAD
      const key = keyCounty(usps, name);
      map.set(key, geoid);
    }
  }
  return map;
}

async function buildZipIndex() {
  const txt = await fetchText(ZCTA_COUNTY_URL);
  const lines = txt.split(/\r?\n/);
  const header = lines[0].split("|");
  const idxZcta = header.indexOf("GEOID_ZCTA5_20");
  const idxCounty = header.indexOf("GEOID_COUNTY_20");
  if (idxZcta < 0 || idxCounty < 0) return [];
  const freq = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split("|");
    const z = cols[idxZcta];
    const fips = cols[idxCounty];
    if (!z || !fips) continue;
    let m = freq.get(z);
    if (!m) {
      m = new Map();
      freq.set(z, m);
    }
    m.set(fips, (m.get(fips) || 0) + 1);
  }
  const out = [];
  for (const [zip, m] of freq.entries()) {
    const total = Array.from(m.values()).reduce((a, b) => a + b, 0) || 1;
    const counties = Array.from(m.entries()).map(([fips, count]) => [
      fips,
      Math.round((count / total) * 1000) / 1000
    ]);
    counties.sort((a, b) => b[1] - a[1]);
    out.push({ zip, counties });
  }
  out.sort((a, b) => a.zip.localeCompare(b.zip));
  return out;
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return dest;
}
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed GET ${url}: ${res.status}`);
  return await res.text();
}

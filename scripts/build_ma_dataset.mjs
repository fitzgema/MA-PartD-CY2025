// scripts/build_ma_dataset.mjs
import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import AdmZip from "adm-zip";
import { parse as parseCsv } from "csv-parse/sync";

const OUT_DIR = path.resolve("dist");
const YEARS = (process.env.TARGET_YEARS || "2025").split(",").map(s => Number(s.trim())).filter(Boolean);

const CMS_URL = process.env.CMS_LANDSCAPE_URL; // e.g. https://www.cms.gov/files/zip/cy2025-landscape-202506.1.zip
if (!CMS_URL) {
  console.error("Missing CMS_LANDSCAPE_URL secret (direct link to CMS Landscape zip).");
  process.exit(1);
}

// Census: ZCTA -> County (no login)
const ZCTA_COUNTY_URL = "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt";
// Census Gazetteer counties (we'll fetch state files and concatenate)
const GAZ_BASE = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer";

const STATES = [
  "01","02","04","05","06","08","09","10","11","12","13","15","16","17","18","19","20","21",
  "22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39",
  "40","41","42","44","45","46","47","48","49","50","51","53","54","55","56"
]; // FIPS states (no PR/territories here)

await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

// 1) Download CMS Landscape ZIP
const cmsZipPath = path.resolve("cms_landscape.zip");
await downloadFile(CMS_URL, cmsZipPath);

// 2) Extract CSV from ZIP
const csvPath = await extractFirstCsv(cmsZipPath);

// 3) Load CSV rows
const csvBuf = await fs.readFile(csvPath);
const rows = parseCsv(csvBuf, { columns: true, skip_empty_lines: true });

// 4) Build county FIPS lookup from Gazetteer (USPS + County NAME -> GEOID)
const countyFipsMap = await buildCountyFipsMap();

// 5) Load ZCTA->County (for ZIP index)
const zipIndex = await buildZipIndex();

// 6) Process per year (usually 1 year, but we support multiples)
for (const year of YEARS) {
  const yearDir = path.join(OUT_DIR, "years", String(year));
  await fs.mkdir(path.join(yearDir, "by-county"), { recursive: true });

  // Filter to this year + Medicare Advantage
  const yrRows = rows.filter(r => Number(r["Contract Year"]) === year && String(r["Contract Category Type"]).toUpperCase().startsWith("MA"));

  // Normalize into contract/plans and county service areas
  // Column names per CY2025 memo:
  //  - "Contract ID", "Plan ID", "Segment ID"
  //  - "Parent Organization Name", "Organization Marketing Name"
  //  - "Plan Name", "Plan Type", "SNP Type"
  //  - "State Abbreviation", "County Name"
  // Some files include "County FIPS"; if not, we join via Gazetteer.
  const carriersByCounty = new Map(); // county_fips -> {county_name,state, carriers: [{orgName, contractIds:Set, plans:[]}]}
  for (const r of yrRows) {
    const state = (r["State Abbreviation"] || "").trim();
    const countyName = (r["County Name"] || "").trim();
    if (!state || !countyName) continue;

    let countyFips = r["County FIPS"] ? String(r["County FIPS"]).zpad?.(5) : countyFipsMap.get(keyCounty(state, countyName));
    if (!countyFips) continue; // skip if we can't resolve

    const contractId = String(r["Contract ID"] || "").trim();
    const planId = String(r["Plan ID"] || "").trim();
    if (!contractId || !planId) continue;

    const orgName = String(r["Parent Organization Name"] || r["Organization Marketing Name"] || "").trim();
    const marketingName = String(r["Plan Name"] || r["Organization Marketing Name"] || "").trim();
    const planType = (r["Plan Type"] || "").trim();
    const snpType = (r["SNP Type"] || "").trim() || null;

    let countyBucket = carriersByCounty.get(countyFips);
    if (!countyBucket) {
      countyBucket = { county_fips: countyFips, state, county_name: countyName, carriers: new Map() };
      carriersByCounty.set(countyFips, countyBucket);
    }

    const key = orgName || contractId;
    let carrier = countyBucket.carriers.get(key);
    if (!carrier) {
      carrier = { orgName: orgName || contractId, contractIds: new Set(), plans: [] };
      countyBucket.carriers.set(key, carrier);
    }
    carrier.contractIds.add(contractId);
    carrier.plans.push({ contractId, planId, marketingName, planType, snpType });
  }

  // Write per-county JSON
  const countyIndex = [];
  for (const [fips, bucket] of carriersByCounty.entries()) {
    const carriers = Array.from(bucket.carriers.values()).map(c => ({
      orgName: c.orgName,
      contractIds: Array.from(c.contractIds),
      plans: c.plans.slice(0, 20) // cap to keep files small
    }));
    const out = { year, county_fips: fips, state: bucket.state, county_name: bucket.county_name, carriers };
    await fs.writeFile(path.join(yearDir, "by-county", `${fips}.json`), JSON.stringify(out, null, 2));
    countyIndex.push({ fips, state: bucket.state, name: bucket.county_name });
  }
  await fs.writeFile(path.join(yearDir, "county-index.json"), JSON.stringify(countyIndex, null, 2));

  // Write ZIP index (from Census ZCTA crosswalk)
  await fs.writeFile(path.join(yearDir, "zip-index.json"), JSON.stringify(zipIndex, null, 2));
}

// copy aliases
await fs.copyFile("data/aliases.json", path.join(OUT_DIR, "aliases.json"));

console.log("Build complete. See ./dist");

/* ---------------- helpers ---------------- */

function keyCounty(stateAbbr, countyName) {
  return `${stateAbbr}::${normalizeCountyName(countyName)}`;
}

// Normalize: remove LSAD (County, Parish, Borough, City and Borough, Municipality, Census Area, Independent City)
function normalizeCountyName(name) {
  const n = String(name).toLowerCase().replace(/county|parish|borough|census area|city and borough|municipality|independent city/gi, "").trim();
  return n.replace(/\s+/g, " ");
}

async function buildCountyFipsMap() {
  const map = new Map();
  // Some states publish per-state files; we iterate states
  for (const st of STATES) {
    const url = `${GAZ_BASE}/2020_gaz_counties_${st}.txt`;
    const txt = await fetchText(url);
    for (const line of txt.split(/\r?\n/)) {
      if (!line || line.startsWith("USPS")) continue;
      const parts = line.split("\t");
      if (parts.length < 5) continue;
      const usps = parts[0];
      const geoid = parts[1]; // 5-digit state+county
      const name = parts[3];
      const key = keyCounty(usps, name);
      map.set(key, geoid);
    }
  }
  return map;
}

async function buildZipIndex() {
  const txt = await fetchText(ZCTA_COUNTY_URL);
  const lines = txt.split(/\r?\n/);
  // Delimiter is |
  const header = lines[0].split("|");
  const idxZcta = header.indexOf("GEOID_ZCTA5_20");
  const idxCounty = header.indexOf("GEOID_COUNTY_20");
  const idxCountyName = header.indexOf("NAMELSAD_COUNTY_20");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split("|");
    const z = cols[idxZcta];
    const fips = cols[idxCounty];
    const cname = cols[idxCountyName];
    if (!z || !fips) continue;
    rows.push({ zcta: z, county_fips: fips, county_name: cname });
  }
  // Build ZIP index: NOTE ZCTA!=ZIP; we use ZCTA as proxy; store as objects with candidate counties (no shares given here)
  const map = new Map();
  for (const r of rows) {
    const zip = r.zcta; // treat ZCTA as 5-digit ZIP-like code
    let entry = map.get(zip);
    if (!entry) { entry = new Map(); map.set(zip, entry); }
    entry.set(r.county_fips, (entry.get(r.county_fips) || 0) + 1);
  }
  const out = [];
  for (const [zip, cmap] of map.entries()) {
    // Convert frequency to pseudo-share
    const total = Array.from(cmap.values()).reduce((a,b)=>a+b,0) || 1;
    const counties = Array.from(cmap.entries()).map(([fips,count]) => [fips, Math.round((count/total)*1000)/1000]);
    counties.sort((a,b)=>b[1]-a[1]);
    out.push({ zip, counties });
  }
  out.sort((a,b)=> a.zip.localeCompare(b.zip));
  return out;
}

async function extractFirstCsv(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  let csvEntry = entries.find(e => e.entryName.toLowerCase().endsWith(".csv"));
  if (!csvEntry) {
    // try Excel -> convert sheet? For simplicity, try to find CSV only
    throw new Error("No CSV found in CMS zip; please provide zip containing CSV.");
  }
  const outPath = path.resolve("cms_landscape.csv");
  await fs.writeFile(outPath, csvEntry.getData());
  return outPath;
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
  if (!res.ok) throw new Error(`Failed to GET ${url}: ${res.status}`);
  return await res.text();
}

String.prototype.zpad = function(n){ return this.toString().padStart(n, "0"); };

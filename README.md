# MA Static API Starter (No-Server ETL)

This repo builds a **static JSON dataset** for *Medicare Advantage carriers by county* (for a given year) and a small ZIP→county index. It runs entirely in **GitHub Actions** and publishes to **GitHub Pages**. Your web app (Replit) fetches the JSON files directly—**no ETL in Replit** and **no server to run**.

**Sources**
- CMS CY20xx **Landscape** file (CSV/XLSX compressed zip) — official plan & service-area metadata. (Example: *CY2025 Landscape (202506.1) (ZIP)* from CMS “Prescription Drug Coverage - General Information”.)
- US Census 2020 **ZCTA→County relationship file** (public, no login): `https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt`.
- US Census 2020 **County Gazetteer** (for county FIPS/name normalization).

> You can optionally swap in HUD USPS ZIP↔County crosswalk by dropping a CSV at `data/hud_zip_county.csv` and setting `USE_HUD=1` in the workflow secret.

## Output (published to GitHub Pages)
```
/dist/
  aliases.json
  years/2025/
    by-county/06075.json            # carriers & plans for San Francisco County, CA
    zip-index.json                  # ZIP → [county_fips,share] candidates
    county-index.json               # County metadata (name, state)
```
Each `/by-county/{FIPS}.json` looks like:
```json
{
  "year": 2025,
  "county_fips": "06075",
  "state": "CA",
  "county_name": "San Francisco County",
  "carriers": [
    {
      "orgName": "UnitedHealthcare",
      "contractIds": ["H0524","H2228"],
      "plans": [
        {"contractId":"H0524","planId":"012","marketingName":"AARP Medicare Advantage Choice (PPO)","planType":"PPO","snpType":null},
        {"contractId":"H2228","planId":"004","marketingName":"UHC Medicare Advantage (HMO)","planType":"HMO","snpType":null}
      ]
    }
  ]
}
```
`zip-index.json` is a compact array of objects: `{ "zip":"94110","counties":[["06075",0.86],["06081",0.14]] }`

## How it works
1. **Action downloads** the CMS Landscape zip and Census relationship files.
2. **Node script** normalizes county names → FIPS, filters to MA (`Contract Category Type = "MA"`), builds per‑county carrier lists & simple ZIP crosswalk.
3. **Action publishes** `/dist` to GitHub Pages. Your site calls:
   - `GET https://<you>.github.io/<repo>/years/2025/by-county/{county_fips}.json`
   - `GET https://<you>.github.io/<repo>/years/2025/zip-index.json` (for ZIP lookup)

## Configure
- Set `CMS_LANDSCAPE_URL` in repo **Secrets** to the direct CMS download link for the year (e.g., `https://www.cms.gov/files/zip/cy2025-landscape-202506.1.zip`).
- Optionally set `TARGET_YEARS` (default `2025`). Example: `2025,2026`.

## Local test
You can run locally with Node 20: `node scripts/build_ma_dataset.mjs` (requires internet).

## License
MIT

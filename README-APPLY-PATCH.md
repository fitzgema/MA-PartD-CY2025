# ZIP → Plans → Details Patch

This update adds:
- `years/2025/zips/<zip>.json` lookup files (ZIP → list of plans).
- New `index.html` with a ZIP input. Enter a ZIP, see all available plans, click one to load its details from:
  - `years/2025/plans/<CODE>.json`
  - `years/2025/by-plan/<CODE>.json`
  - `years/2025/plan-details/<CODE>.json`

### Sample included
- `years/2025/zips/55401.json` → contains one plan `H2458-002` (matching the existing sample).

### How to use
1) Copy these files into the **repo root**.
2) Commit & push to the branch GitHub Pages publishes.
3) Create real `years/2025/zips/<zip>.json` files for your target ZIPs.
   - Each item in the array should include: `zip,state,county,contractId,planId,planCode,organization,planName,premium,starRating,type`

The `index.html` first tries your GitHub Pages URLs and automatically falls back to `raw.githubusercontent.com` so it works immediately.

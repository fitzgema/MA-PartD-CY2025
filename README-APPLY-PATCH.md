# MA-PartD-CY2025 Patch

**What this includes**
- `.nojekyll` — required so GitHub Pages serves JSON as-is.
- `index.html` — single-page viewer that loads:
  - `years/2025/plans/H2458-002.json`
  - `years/2025/by-plan/H2458-002.json`
  - `years/2025/plan-details/H2458-002.json`
  It also auto-falls back to `raw.githubusercontent.com` so you can test immediately even if Pages isn’t on yet.
- The three JSON files above (sample data).

**How to apply**
1. Copy the files/folders into the **repo root** of `MA-PartD-CY2025`.
2. Commit & push.
3. If using GitHub Pages, ensure Pages is enabled on the repo. The JSON URLs will then resolve:
   - https://fitzgema.github.io/MA-PartD-CY2025/years/2025/plans/H2458-002.json
   - https://fitzgema.github.io/MA-PartD-CY2025/years/2025/by-plan/H2458-002.json
   - https://fitzgema.github.io/MA-PartD-CY2025/years/2025/plan-details/H2458-002.json

You can open `index.html` locally or via Pages to verify everything renders.

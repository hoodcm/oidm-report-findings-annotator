# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Note**: This tool was developed within [report-labeler-concordance](https://github.com/hoodcm/report-labeler-concordance) through versions 0.2.0–1.1.0 before being extracted to its own repo. The history below covers annotation-tool-relevant changes from the parent project.

---

## [Unreleased]

## [1.1.1] - 2026-02-13

### Fixed

- **[IE1] Non-atomic report upload** — `confirmUpload()` and `loadSampleData()` now build a reports array and call `Storage.atomicReplace()` instead of clear + loop of `saveReport()`, preventing partial data on browser crash.
- **[IE2] Extraction import silently destroys validated findings** — Now warns (red banner) when import will delete validated findings, not just pending extractions.
- **[IE3] Session restore missing sentence re-parse** — Reports from older sessions lacking a `sentences` array are now re-parsed on restore.
- **[IE4] CSV export missing UTF-8 BOM** — CSV downloads now prepend UTF-8 BOM (`\uFEFF`) so Windows Excel correctly handles non-ASCII clinical text.
- **[IE5] Validation errors not shown via toast** — `confirmUpload()` now shows a toast when upload mapping validation fails.
- **[IE6] Session export dead csv_content** — Removed unused `csv_content` field and its PapaParse construction from `exportSession()`, reducing file size.
- **[UI1] Presence dropdown stale after re-render** — Replaced `:selected` on `<option>` with `:value` on `<select>` for proper Alpine.js reactivity.
- **[UI2] Toast timer race** — New toast now clears previous timer so it displays for the full 3 seconds.
- **[UI3] Escape doesn't close stats overlay** — Escape key now closes both shortcuts and stats overlays.
- **[UI4] Details `:open` overrides user toggle** — Removed reactive `:open` binding on attributes `<details>` so user can freely toggle it.
- **[UI5] Validated badge missing `x-cloak`** — Added `x-cloak` to prevent flash of "Validated" badge before Alpine initializes.
- **[UI6] Text preview always appends "..."** — Ellipsis now only shown for text longer than 100 characters.
- **[UI7] Auto-advance timeout not cancellable** — User navigation within 300ms now cancels pending auto-advance `setTimeout`.
- **[UI8] Sentence nav doesn't auto-scroll** — `selectSentence()` now scrolls the selected sentence into view on long reports.
- **[UI9] `validatedIds` Set mutation not triggering reactivity** — `.add()`/`.delete()` now followed by `new Set()` reassignment to trigger Alpine reactivity.
- **[UI10] Null coercion in sentence-down handler** — j/k handlers now explicitly check for `null` index and select first/last sentence respectively.
- **[H1] Session restore atomic** — Clear + import now wrapped in a single Dexie transaction to prevent data loss if import fails mid-way.
- **[H2] CSV export dynamic columns** — Both `exportCurrentReportCsv` and `exportAllCsv` now build attribute columns from `attributeConfig` instead of a hardcoded list, so new attributes appear automatically.
- **[H3] Session export CSV escapes record_id** — `record_id` now gets double-quote escaping in the embedded CSV, preventing malformed output.
- **[M1] Null guard on file handlers** — `handleReportsCsvUpload`, `handleExtractionCsvUpload`, and `restoreSession` no longer crash on cancelled file dialogs or non-file drops.
- **[M2] CSV parse error handling** — Both CSV upload handlers now catch parse failures and show a user-visible toast.
- **[M3] Session restore validates reports** — Reports without `record_id` are filtered out with a warning instead of crashing IndexedDB.
- **[L1] File inputs reset after use** — All 4 file inputs clear their value so re-selecting the same file fires the change event.
- **[L2] Sanitized download filenames** — Record IDs with `/`, `\`, or special characters are replaced with `_` in export filenames.
- **[L3] Template CSV uses PapaParse** — Extraction template now generated with `Papa.unparse()` for proper quoting.
- **[L4] Init fetch error handling** — Critical data fetches (`taxonomy.json`, `attributes.json`, `actionability-rules.json`) now show a toast on failure instead of failing silently.
- **[M4] loadSampleData() error handling** — Sample reports fetch now has try/catch with toast on failure instead of unhandled promise rejection.
- **[L5] Upload/extraction state memory leak** — Parsed CSV data (`uploadData`, `extractionData`, etc.) now cleared after import completes to free memory.
- **[L6] exportSession() hand-rolled CSV** — Session export CSV now uses PapaParse instead of manual string construction for consistency and edge-case safety.
- **[L7] restoreSession bypassed Storage abstraction** — Atomic restore now uses `Storage.atomicReplace()` instead of accessing global `db` directly.
- **[L8] Download blob URL revocation race** — `URL.revokeObjectURL` now deferred 1s after `click()` to avoid revoking before browser initiates download.
- **[S1] Tabler Icons pinned to v3.36.1** — CDN link changed from `@latest` to `@3.36.1` to prevent unexpected breakage or supply-chain risk.
- **[S2] Prototype chain safety in normality lookups** — `in` operator replaced with `Object.hasOwn()` to prevent prototype property collisions.
- **[B3] Welcome screen hardcoded taxonomy count** — "313 recognized finding names" replaced with dynamic `$store.app.taxonomy.length` so the count stays accurate as the taxonomy grows.

### Changed

- **CSV export parity with JSON** — CSV exports now include the same data as JSON: both validated and pending findings (with `status` column), `source_text` (sentence text), and report-level metadata (`report_validated`, `report_validated_at`). Renamed `validated-findings.csv` → `all-findings.csv` to reflect broader scope.

---

## [1.1.0] - 2026-02-13

### Changed

- **Migrated to standalone public repo** — Extracted from `report-labeler-concordance/cxr-annotation-tool/` to [hoodcm/cxr-annotation-tool](https://github.com/hoodcm/cxr-annotation-tool) with its own GitHub Pages deployment.

### Fixed

- **Extraction import hardcoded attributes** — Import was missing `tip_location` and `position_status` attributes. Now dynamically loads all attributes from `attributeConfig` so new attributes appear automatically.

### Added

- **7 new taxonomy entries** (taxonomy now at 324 findings) — Obscuration of hemidiaphragm, Calcification of hilar lymph node, Resection of clavicle, Pectus excavatum repair, Sternal fixation, Tricuspid annuloplasty ring, Widening of rib interspaces.
- **3 synonym additions** — Soft tissue calcification, Rib fixation, Thickening of interstitium.

## [1.0.0] - 2026-02-12

### Added

- **GitHub Pages deployment** — GitHub Actions workflow deploys on push to main. Static site, no build step.
- **Extraction CSV Format Guide** (`extraction-format-guide.html`) — Documents every column in the import CSV format with types, valid values, and examples. Linked from welcome screen and sidebar.
- **4 new taxonomy entries** — Bulla, Depression of hemidiaphragm, Diaphragmatic abnormality, Lordotic positioning. Taxonomy at 317 findings.
- **22 synonym additions** to improve extraction import matching.
- **"Continue Annotating" banner** on welcome screen when data is already loaded.
- **JSON-to-CSV compiler script** in parent project for testing import pipeline.

### Changed

- **Menu restructure: "Data & Export" → "Session & Export"** — Compact 2x2 export grid (This report / All reports × JSON / CSV). Renamed "Import Extractions" to "Import LLM Extractions".
- **Welcome screen reframed** — "Pre-extract with an LLM" → "Test Your Own Extraction Algorithm" with vertical download list (template, prompt, taxonomy reference).
- **Home button enlarged** — Icon-only → gray pill with "Home" text.
- **Stats icon in progress bar** — Chart icon next to validated/total count.
- **Sample reports replaced** with richer examples from corpus (devices, measurements, bilateral findings, uncertainty, recommendations).
- **Toast notifications moved to bottom-center** from bottom-right.
- **Session & Export vertical spacing increased** for less cramped feel.

### Fixed

- **Extraction import column auto-detection** — Substring matching caused greedy mis-mapping. Now uses two-pass detection (exact first, then substring) with claimed-field tracking.
- **CSV column mapping allowed empty selections** — Normalized to empty string, added guard and early return.
- **Fracture acuity defaults to significant** — Unspecified chronicity now defaults to significant (clinically safer) instead of incidental.
- **Actionability badges showed incidental/conditional** — Tightened to only show critical and significant.
- **Section header spacing** — Flex gap caused visible spaces in parenthesized counts.
- **Enter key on attribute text inputs** now commits the value.
- **Welcome & upload-mapping viewport overflow** — Replaced `justify-center` with top padding for scrollable content.

## [0.15.0] - 2026-02-09

### Added

- **Actionability system** — 4-tier classification (critical/significant/conditional/incidental). Base tiers on all findings, conditional rules from YAML, runtime resolution with UI badges.
- **8 new taxonomy entries** — Alveolar pulmonary edema, Dilation of bowel, Pulmonary vascular abnormality, Air-fluid level, Support device, Tunneled catheter, Introducer sheath, Vascular stent. Taxonomy at 313 entries.

### Changed

- **Taxonomy consolidations** — Merged Diffuse interstitial opacities → Reticular opacities, deleted Lobar opacity, renamed Mucus plugging → Bronchial occlusion.

## [0.14.0] - 2026-02-08

### Added

- **Route test suite** — 54 tests covering navigation, sentence selection, findings CRUD, validation, export, sample data.
- **Taxonomy expanded 284 → 306** — 21 new entries from corpus audit, synonym additions across 33 entries.

### Changed

- **Pared taxonomy synonyms** — 266 → 185 for LLM token efficiency. Retained abbreviations, brand names, clinically distinct terms.

### Fixed

- Validate button losing sentence context, session export crash, attribute delete leaving None, toast stacking.

## [0.13.0] - 2026-02-08

Bug-fix sweep (16 critical/high fixes) and UI overhaul.

### Fixed

- **[Critical] Dataset replacement leaves orphaned annotations** — Clear before cache reset.
- **5 data integrity fixes** — Auto-create unsaved reports, atomic session restore with rollback, record ID type normalization, path traversal validation, negative index bounds checking.
- **Welcome screen usability** — 8 issues fixed (back link, contextual subtitles, layout balance, drop zone filenames).
- **Features array rendered as Python list repr** — Now displays as comma-separated text.
- Medium/low fixes: progress denominator, event delegation, JS escaping, CSV export headers, sidebar stats, panel width.

### Added

- **Interactive "Add Attribute" UI** — Dropdown with dynamic enum/text rendering from YAML schema.
- **Drag-and-drop upload zones** and CSV replacement confirmation dialog.
- **Sample data for onboarding** — "Try with sample reports" loads 5 demo CXR reports.

### Changed

- **Sidebar redesign** — Merged 3 sections into 1, collapsed Data & Export.
- **Finding name normalization** — `lowercase_underscore` → canonical "Capitalized Spaced" form.
- **Attribute UX improvements** — Delete buttons, auto-open, one-per-line, alignment polish.

## [0.12.0] - 2026-02-08

Standalone app readiness — CSV upload, session management, extraction import, keyboard workflow.

### Added

- **Client-side annotation tool** — Pure browser SPA with Alpine.js, Dexie.js, PapaParse, Tailwind CSS. 12 files, ~2200 lines. Feature parity with server-rendered app:
  - Welcome view: CSV upload (column mapping + validation), session restore, sample data
  - 3-column annotation workspace: sidebar, report view (sentence highlighting), findings panel
  - Finding operations: taxonomy search (313 findings), accept/reject, add from taxonomy/custom, delete, presence, attribute editor
  - Actionability badges with runtime resolution from conditional rules
  - Keyboard shortcuts: arrows/u/i (reports), j/k (sentences), a/r (accept/reject), f (search), n (next unvalidated), ? (overlay)
  - Import/export: session save/restore, JSON/CSV export, taxonomy CSV, extraction CSV import with taxonomy matching
  - Auto-advance after validation
- **Feature parity: 14 gap closures** — URL routing/browser history, file size limits, multi-encoding CSV fallback, normality mappings, source text→sentence matching, extraction import overhaul (3-category taxonomy matching with fuzzy accept/reject), template CSV/LLM prompt downloads, custom findings export, annotation stats modal, session format compatibility.
- **External extraction upload** — 3-step CSV flow with column mapping, fuzzy taxonomy matching (Jaccard), unassigned findings section.
- **Session save/restore** — Self-contained JSON, portable backup. 50 MB limit.
- **Welcome screen with CSV upload** — Column mapping with heuristic defaults, multi-encoding fallback, 10 MB limit.
- **Keyboard shortcuts** — `?` overlay, `f` focus search, `n` next unvalidated, `a`/`r` accept/reject.
- **beforeunload warning** for unexported changes.

### Changed

- **Manual annotation streamlined to 2-click** — Click sentence → click finding (was 6 steps). Presence defaults to "present".
- **Dynamic subsection header detection** — Regex-based instead of hardcoded CXR names.
- **Generic branding** — "Report Annotator" for modality-agnostic use.

### Fixed

- **J/K navigation broken** — Multiple focus mechanisms fighting. Solved with `keyboardNavigating` flag.
- **Extraction import DataCloneError** — Alpine.js proxy serialization before IndexedDB write.
- **Extraction column mapping display** — `x-model`/`x-for` timing issue, fixed with deferred frame.
- **FINDINGS section colon handling** — Regex now matches `FINDINGS:` in addition to `FINDINGS `.

## [0.11.0] - 2026-02-06

Taxonomy hierarchy and naming standardization.

### Added

- **Taxonomy hierarchy** — `parent_id` column for hierarchical concordance scoring.
- **6 new device/postsurgical entries** — Esophageal stent, valve replacements, Feeding tube, Median sternotomy, Thoracotomy.

### Changed

- **Grammatical nominalization (15 entries)** — Adjective-noun → "[Noun] of [Anatomy]" form.
- **Mass consolidation** — 6 site-specific mass entries → generic Mass + anatomic_site.
- **Fracture hierarchy** — 8 site-specific → generic Fracture + anatomic_site.
- **Synonym data consolidated** — CSV as single source of truth.

### Fixed

- Sentence index off-by-one, duplicate FID codes, features attribute display.

## [0.10.0] - 2026-02-01

### Added

- **`features` array attribute** — Captures properties that can't exist independently (cavitation, tension). Decision rule: independent on image → separate finding; property of primary → features array.

### Fixed

- **Off-by-one in exports** — 1-based `source_sentence_idx` used directly as array index.

## [0.9.0] - 2026-01-31

### Changed

- **CSV is single source of truth for taxonomy** — Migrated from markdown to `findings_taxonomy.csv` with stable FID identifiers.
- **Dynamic extraction attributes from YAML** — `schema/attributes.yaml` replaces 5-location hardcoding.
- **Presence moved into attributes dict** — Consistent data model, simplified exports.

## [0.7.0] - 2026-01-28

### Added

- **CXR radiologist approach module** — Modality-specific extraction rules: normality patterns, modifier rules, device conventions, bilateral handling, findings-vs-diagnoses boundary.
- **55+ synonym groups** organized by anatomic category.

## [0.6.0] - 2026-01-28

### Changed

- **Report view redesigned with inline highlights** — Prose text with colored spans (green=validated, amber=pending, blue=selected).
- **Streamlit removed** — Application exclusively uses FastAPI + HTMX (later replaced by Alpine.js SPA).

### Added

- **Attribute editing in findings panel** — 6 attributes with inline dropdowns/inputs.
- **Quick jump navigation** — Editable report number input.

## [0.4.0] - 2026-01-26

### Added

- **FastAPI + HTMX annotation UI** — Replaced Streamlit. Routes, Jinja2 templates, Tailwind CSS, keyboard shortcuts. *Later replaced by Alpine.js SPA in v0.12.0.*

## [0.2.0] - 2026-01-26

### Added

- **Annotation Tool MVP** — Streamlit app for validating LLM-extracted findings. Core modules: models, taxonomy (176 findings), storage, extractor. *Replaced by FastAPI+HTMX in v0.4.0.*

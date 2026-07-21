# OIDM Report Findings Annotator

**Version 2.0.0** — July 2026

A browser-based tool for annotating radiology reports with structured findings. No installation, no accounts, no data leaves your computer.

**Try it:** [hoodcm.github.io/oidm-report-findings-annotator](https://hoodcm.github.io/oidm-report-findings-annotator/)

## What It Does

Upload a CSV of radiology reports and annotate each sentence with standardized finding names from a controlled taxonomy. The tool tracks your progress, saves your work automatically, and exports structured CSV or JSON for downstream analysis.

Supports multiple exam types (chest X-ray, head CT, MSK, mammography, MRI spine) through swappable taxonomy files. Upload a taxonomy CSV for your exam type on first use.

For large datasets, you can have an LLM pre-extract findings from your reports, import the extractions, and review them instead of annotating from scratch.

## Getting Started

1. Open the tool in any modern browser (Chrome, Firefox, Safari, Edge).
2. Drop your files on the welcome screen — in any order. The tool recognizes each by its content: a taxonomy CSV or `.idm` bundle, a reports CSV with an ID column and a report text column, LLM extractions, or a saved session.
3. Click sentences to select them, search for findings, and tag each sentence.
4. Set finding attributes (presence, laterality, severity, etc.) as needed. Mark any single attribute as *hedged* (uncertain) with the eye icon on its row.
5. Flag a problem finding or a problem exam (wrong heading, un-annotatable) with the flag icon, and add an optional note — the flag rides along in your exports.
6. Mark each report as validated when done. Accidental edits can be undone (Ctrl+Z or the toast's Undo).
7. Export your annotations as CSV or JSON.

## LLM-Assisted Workflow

1. Open the LLM extractions playbook from the welcome screen — copy or download the prompt with your active taxonomy already injected.
2. Run it against your reports with any LLM.
3. Import the output JSON (or CSV) via "Import LLM Extractions" in the sidebar.
4. Review each extracted finding: accept, reject, or correct.

See the [LLM extractions playbook](https://hoodcm.github.io/oidm-report-findings-annotator/pages/llm-extractions.html) for the prompt, the upload format, and help when imports fail. The prompt is an example, not a production extraction pipeline. Review every imported finding.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `u` / `i` or `←` `→` | Previous / next report |
| `j` / `k` | Previous / next sentence |
| `a` | Accept top pending finding |
| `r` | Reject top pending finding |
| `d` | Cycle presence (present / possible / no definite / absent) |
| `f` | Focus finding search |
| `n` | Next unvalidated report |
| `?` | Show all shortcuts |

The sidebar also has a `?` **annotation guidelines** button — a quick reference for presence semantics, taxonomy-match vs. custom, the "needs review" badge, sentence highlight colors, and when to mark a report Validated.

## FAQ

**Where is my data stored?**
In your browser's IndexedDB. All processing happens in your browser; reports are never sent to any server. Data persists between sessions, but clearing browser data will erase it. The app keeps a few rolling snapshots of its own (restorable from the welcome screen), but export session backups regularly for anything you can't afford to lose.

**Can I resume later?**
Yes. Work auto-saves in the browser. You can also export a session backup (JSON) and restore it on any machine.

**What CSV format do I need for reports?**
A header row with at least an ID column and a report text column. UTF-8 recommended. The tool auto-detects columns and lets you confirm.

**What taxonomy format do I need?**
A CSV with `id, name, category, parent_id, synonyms, finding_type` columns, or an `.idm` bundle. Ready-made taxonomies for several exam types are available from the [imaging-findings-workbench](https://github.com/hoodcm/imaging-findings-workbench). Drop the file on the welcome screen like any other file.

**Why don't I see every attribute on every finding?**
Universal attributes (presence, laterality, severity, etc.) are always available. Device-specific attributes (tip location, position status, insertion site, integrity) are offered only for device findings, where they apply. Anything already set on a finding always stays visible.

**I made a mistake — can I undo it?**
Yes. Ctrl+Z (or the Undo button on the toast) reverses the last edit. Destructive operations (new upload, restore, clear-all) automatically snapshot your data first, and those snapshots are restorable from the welcome screen.

**Does it work offline?**
Yes. After the first load, everything runs locally — no CDN, no runtime network access.

**Can multiple people annotate the same reports?**
Each person annotates independently in their own browser. Export each annotator's results and compare externally.

---

<details>
<summary>For developers</summary>

Pure static SPA — Alpine.js, Dexie.js (IndexedDB), PapaParse (CSV), Tailwind CSS (precompiled), fflate (`.idm` bundles), Tabler Icons — all vendored under `vendor/`; no build step, no CDN.

```bash
# Local development
python3 -m http.server 8501    # then open http://localhost:8501

# Tests
node tests/run.js       # unit + contract tests (pure Node)
npx playwright test     # E2E tests (Playwright, Chromium)
```

Both test layers run in CI on every PR.

</details>

## Author

[Michael Hood, MD](https://github.com/hoodcm) ([ORCID 0009-0005-8708-1118](https://orcid.org/0009-0005-8708-1118)) · [OIDM](https://openimagingdata.org)

## License

Copyright 2026 Michael Hood (ORCID: 0009-0005-8708-1118)

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text, or <https://www.apache.org/licenses/LICENSE-2.0>.

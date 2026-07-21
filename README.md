# OIDM Report Findings Annotator

**Version 2.0.0** — July 2026

A browser-based tool for annotating radiology reports with structured findings. No installation, no accounts, no data leaves your computer.

**Try it:** [hoodcm.github.io/oidm-report-findings-annotator](https://hoodcm.github.io/oidm-report-findings-annotator/)

## What's New in 2.0

- **Cluster-gated attribute picker.** The "+ attribute" picker now offers device-cluster attributes (tip location, position status, insertion site, integrity) only for findings that carry the owning cluster — universal attributes are still always offered, and already-set values always render regardless.
- **One drop zone for everything.** Drop your taxonomy, reports, LLM extractions, or a saved session on the welcome screen in any order — the tool recognizes each file by its content.
- **Your work is harder to lose.** Rolling backups with one-click restore from the welcome screen, and Ctrl+Z undoes an accidental edit.
- **Friendlier LLM extraction import.** Plain-language messages and one-click fixes when something doesn't match.
- **Works fully offline**, and saving, restoring, and exporting are more dependable under the hood.

## What It Does

Upload a CSV of radiology reports and annotate each sentence with standardized finding names from a controlled taxonomy. The tool tracks your progress, saves your work automatically, and exports structured CSV or JSON for downstream analysis.

Supports multiple exam types (chest X-ray, head CT, MSK, mammography, MRI spine) through swappable taxonomy files from the [imaging-findings-workbench](https://github.com/hoodcm/imaging-findings-workbench). Upload a taxonomy CSV for your exam type on first use.

For large datasets, you can have an LLM pre-extract findings from your reports, import the extractions, and review them instead of annotating from scratch.

## Data Privacy

All processing happens in your browser. Reports are stored in IndexedDB locally and are never sent to any server.

## Getting Started

1. Open the tool in any modern browser (Chrome, Firefox, Safari, Edge).
2. Drop your files on the welcome screen — in any order. The tool recognizes each by its content: a taxonomy CSV (workbench format: `id, name, category, parent_id, synonyms, finding_type`) or an `.idm` bundle, a reports CSV with an ID column and a report text column, LLM extractions, or a saved session.
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
In your browser's IndexedDB. It persists between sessions but clearing browser data will erase it. The app keeps a few rolling snapshots of its own (restorable from the welcome screen), but export session backups regularly for anything you can't afford to lose.

**Can I resume later?**
Yes. Work auto-saves in the browser. You can also export a session backup (JSON) and restore it on any machine.

**What CSV format do I need?**
A header row with at least an ID column and a report text column. UTF-8 recommended (ask your LLM to ensure this). The tool auto-detects columns and lets you confirm.

**Can multiple people annotate the same reports?**
Each person annotates independently in their own browser. Export each annotator's results and compare externally.

---

<details>
<summary>Technical details</summary>

### Stack

Alpine.js, Dexie.js (IndexedDB), PapaParse (CSV), Tailwind CSS (precompiled), fflate (`.idm` bundles), Tabler Icons — all vendored under `vendor/`; no CDN, no runtime network access.

### Local development

```bash
python3 -m http.server 8501
# http://localhost:8501
```

If JavaScript edits don't appear after a reload, do a hard reload (Cmd/Ctrl+Shift+R) to bypass the browser cache.

### Tests

```bash
node tests/run.js       # unit + contract tests (pure Node)
npx playwright test     # E2E tests (Playwright, Chromium)
```

Both layers run in CI on every PR via `.github/workflows/test.yml`.

### Files

```
index.html                # Alpine.js SPA
js/app.js                 # Core logic + Alpine store
js/storage.js             # IndexedDB (reports + taxonomy + backups + data assets)
js/schema.js              # Attribute-schema accessor (wraps data/attributes.json)
js/taxonomy.js            # Finding search/matching
js/sentences.js           # Report text parsing
js/exam-type.js           # Exam-type label deriver (modality-acronym aware)
js/extraction-import.js   # Extraction import (JSON + CSV)
js/extraction-prompt.js   # Prompt builder (single source of truth)
js/extraction-example.js  # Shared worked-example fixture
js/file-classifier.js     # Universal drop-zone file routing
js/idm-loader.js          # .idm bundle reader (zip + manifest)
js/undo.js                # Snapshot undo ring buffer
css/                      # Custom styles + precompiled Tailwind
vendor/                   # Vendored runtime dependencies
pages/llm-extractions.html       # LLM playbook (prompt + import + reference)
pages/reports-format-guide.html  # Reports CSV format docs
data/attributes.json             # Attribute definitions
tests/                    # Unit + contract tests (Node) + browser runner
tests/e2e/                # Playwright specs
```

</details>

## Author

[Michael Hood, MD](https://github.com/hoodcm) ([ORCID 0009-0005-8708-1118](https://orcid.org/0009-0005-8708-1118)) · [OIDM](https://openimagingdata.org)

## License

Copyright 2026 Michael Hood (ORCID: 0009-0005-8708-1118)

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text, or <https://www.apache.org/licenses/LICENSE-2.0>.

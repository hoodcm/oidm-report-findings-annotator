# OIDM Report Findings Annotator

A browser-based tool for annotating radiology reports with structured findings. No installation, no accounts, no data leaves your computer.

**Try it:** [hoodcm.github.io/oidm-report-findings-annotator](https://hoodcm.github.io/oidm-report-findings-annotator/)

## What It Does

Upload a CSV of radiology reports and annotate each sentence with standardized finding names from a controlled taxonomy. The tool tracks your progress, saves your work automatically, and exports structured CSV or JSON for downstream analysis.

Supports multiple exam types (chest X-ray, head CT, MSK, mammography, MRI spine) through swappable taxonomy files from the [imaging-findings-workbench](https://github.com/hoodcm/imaging-findings-workbench). A chest X-ray taxonomy is included by default.

For large datasets, you can have an LLM pre-extract findings from your reports, import the extractions, and review them instead of annotating from scratch.

## Data Privacy

All processing happens in your browser. Reports are stored in IndexedDB locally and are never sent to any server.

## Getting Started

1. Open the tool in any modern browser (Chrome, Firefox, Safari, Edge).
2. Optionally upload a taxonomy CSV for your exam type. CXR loads by default.
3. Upload a reports CSV with an ID column and a report text column.
4. Click sentences to select them, search for findings, and tag each sentence.
5. Set finding attributes (presence, laterality, severity, etc.) as needed.
6. Mark each report as validated when done.
7. Export your annotations as CSV or JSON.

## LLM-Assisted Workflow

1. Open the LLM extractions playbook from the welcome screen — copy or download the prompt with your active taxonomy already injected.
2. Run it against your reports with any LLM.
3. Import the output JSON (or CSV) via "Import LLM Extractions" in the sidebar.
4. Review each extracted finding: accept, reject, or correct.

See the [LLM extractions playbook](https://hoodcm.github.io/oidm-report-findings-annotator/pages/llm-extractions.html) for the prompt, the upload format, and help when imports fail.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `u` / `i` or `←` `→` | Previous / next report |
| `j` / `k` | Previous / next sentence |
| `a` | Accept top pending finding |
| `r` | Reject top pending finding |
| `d` | Cycle presence (present / absent / indeterminate) |
| `f` | Focus finding search |
| `n` | Next unvalidated report |
| `?` | Show all shortcuts |

## FAQ

**Where is my data stored?**
In your browser's IndexedDB. It persists between sessions but clearing browser data will erase it. Export session backups regularly.

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

Alpine.js, Dexie.js (IndexedDB), PapaParse (CSV), Tailwind CSS (Play CDN), Tabler Icons

### Local development

```bash
python3 -m http.server 8501
# http://localhost:8501
```

### Files

```
index.html                # Alpine.js SPA
js/app.js                 # Core logic
js/storage.js             # IndexedDB (reports + taxonomy)
js/taxonomy.js            # Finding search/matching
js/sentences.js           # Report text parsing
js/extraction-import.js   # Extraction import (JSON + CSV)
js/extraction-prompt.js   # Prompt builder (single source of truth)
pages/llm-extractions.html  # LLM playbook (prompt + import + reference)
pages/reports-format-guide.html
data/attributes.json                # Attribute definitions
```

</details>

## Author

[Michael Hood, MD](https://github.com/hoodcm) · [OIDM](https://openimagingdata.org) ·  · 

## License

MIT
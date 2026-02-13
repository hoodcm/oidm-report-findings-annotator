# CXR Annotation Tool

Browser-based radiology report annotation tool for mapping narrative reports to structured findings using the OIFM (Open Imaging Finding Model) taxonomy.

**Live:** [hoodcm.github.io/cxr-annotation-tool](https://hoodcm.github.io/cxr-annotation-tool/)

## Features

- **CSV upload** with column mapping and multi-encoding fallback
- **3-column annotation workspace**: sidebar navigation, report view with sentence highlighting, findings panel
- **313-finding taxonomy** with autocomplete search and synonym matching
- **Actionability badges** (critical/significant) with conditional rule resolution
- **Import LLM extractions** with fuzzy taxonomy matching and review UI
- **Keyboard shortcuts**: arrow keys, j/k (sentences), a/r (accept/reject), f (search), n (next unvalidated), ? (help)
- **Session save/restore** and JSON/CSV export
- **Sample reports** for trying the tool without your own data

## Tech Stack

- **Alpine.js** — reactive UI
- **Dexie.js** — IndexedDB persistence
- **PapaParse** — CSV parsing
- **Tailwind CSS** (Play CDN) — styling
- **Tabler Icons** — iconography

Zero build step. Pure static files.

## Usage

### Online

Visit the [live site](https://hoodcm.github.io/cxr-annotation-tool/) — no installation needed.

### Local

```bash
python3 -m http.server 8501
# Open http://localhost:8501
```

## Data Files

The `data/` directory contains static JSON generated from the parent taxonomy project:

| File | Contents |
|------|----------|
| `taxonomy.json` | 313 findings with categories, synonyms, actionability tiers |
| `attributes.json` | Attribute definitions (presence, temporal status, chronicity, etc.) |
| `actionability-rules.json` | Conditional rules for actionability resolution |
| `normality-mappings.json` | Normality phrase-to-finding mappings |
| `sample-reports.json` | 5 sample CXR reports for demo |

## Author

Created by [Michael Hood](https://github.com/hoodcm) as part of the [Open Imaging Data Model (OIDM)](https://github.com/openimagingdata) initiative.

## License

MIT — Copyright (c) 2026 Michael Hood

# CXR Annotation Tool

A free, browser-based tool for converting radiology reports into structured data. No installation, no accounts, no data leaves your computer.

**Use it now:** [hoodcm.github.io/cxr-annotation-tool](https://hoodcm.github.io/cxr-annotation-tool/)

---

## The Problem

Radiology reports are written as free-text narratives — a radiologist dictates what they see in their own words. While this works well for clinical communication, it creates a challenge for research, quality measurement, and AI evaluation: **free-text reports can't be directly compared, counted, or analyzed by computers.**

To do things like:

- Evaluate how well an AI chest X-ray system performs
- Measure agreement between radiologists
- Build datasets for training or benchmarking

...you first need to **convert each report into a standardized, structured format** — mapping the radiologist's narrative sentences to specific, recognized finding names from a controlled vocabulary.

Doing this by hand is slow. This tool makes it fast, consistent, and reviewable.

## What This Tool Does

The CXR Annotation Tool provides a structured workspace for reading radiology reports sentence by sentence and tagging each sentence with the specific findings it describes.

The workflow is:

1. **Upload** a CSV file containing your radiology reports (or try the built-in sample reports)
2. **Read** each report — the tool splits it into individual sentences and highlights them
3. **Annotate** each sentence by searching a curated taxonomy of **324 recognized chest X-ray findings** and selecting the matching ones
4. **Set attributes** for each finding — whether it's present or absent, its laterality, severity, and other properties
5. **Validate** each report once all sentences are annotated
6. **Export** the structured results as JSON or CSV for downstream analysis

The tool also supports a faster **hybrid workflow**: have an AI/LLM pre-extract findings from your reports, then import those extractions and review them (accept, reject, or correct) instead of annotating from scratch. This can dramatically reduce annotation time.

## Data Privacy

**All processing happens entirely in your web browser.** Your report data is never uploaded to any server. It is stored locally in your browser's built-in storage (IndexedDB) and stays on your machine. There are no accounts, no logins, and no cloud services involved.

This means the tool is safe to use with sensitive or protected health information (PHI), as the data never leaves your computer. However, you should still follow your institution's policies regarding PHI handling.

## Getting Started

### Step 1: Open the tool

Go to **[hoodcm.github.io/cxr-annotation-tool](https://hoodcm.github.io/cxr-annotation-tool/)** in any modern web browser (Chrome, Firefox, Safari, or Edge). There is nothing to install.

### Step 2: Load your reports

You have two options:

- **Upload a CSV** — Your file needs at minimum an ID column (a unique identifier for each report) and a report text column (the narrative text). The tool will ask you to map your columns after upload.
- **Try sample reports** — Click "Try with sample reports" on the welcome screen to load 5 example chest X-ray reports and explore the tool without your own data.

### Step 3: Annotate

Work through each report, annotating sentences with findings. The tool tracks your progress and saves your work automatically.

### Step 4: Export

When you're done (or at any point), export your structured annotations as JSON or CSV files for use in your analysis.

## The Annotation Workspace

Once reports are loaded, the tool presents a **three-column layout**:

| Column | What it shows |
|--------|---------------|
| **Left sidebar** | List of all reports, your progress, navigation controls, and export options |
| **Center panel** | The full report text with individual sentences highlighted in color |
| **Right panel** | The findings assigned to the currently selected sentence |

### Sentence colors

Sentences in the center panel are color-coded to show their annotation status:

| Color | Meaning |
|-------|---------|
| **Green** | Validated — annotation is complete and confirmed |
| **Amber** | Has findings assigned but not yet validated |
| **Blue** | Currently selected (the one you're working on) |
| No highlight | Not yet annotated |

### Annotating a sentence

1. **Click a sentence** in the center panel to select it
2. **Search for a finding** using the search box in the right panel — type a finding name (e.g., "pleural effusion") and the tool will show matching results from the taxonomy, including synonyms
3. **Click a finding** to add it to the sentence
4. **Set attributes** — adjust presence (present, absent, indeterminate, conditional), laterality, severity, and other properties as needed
5. Move to the next sentence and repeat

### Validating a report

Once all sentences in a report have been reviewed, click **Validate** to mark the report as complete. Validated reports are tracked in the sidebar progress counter.

## LLM-Assisted Workflow

For large datasets, you can speed up annotation by having an AI or language model pre-extract findings from your reports, then import those extractions for human review.

1. **Extract findings** from your reports using an LLM of your choice (the tool provides a downloadable prompt template and taxonomy reference to help)
2. **Format the extractions** as a CSV following the [Extraction CSV Format Guide](https://hoodcm.github.io/cxr-annotation-tool/extraction-format-guide.html)
3. **Import** the extraction CSV into the tool — it will automatically match extracted finding names to the taxonomy
4. **Review** each finding: accept correct extractions, reject incorrect ones, and add any that the LLM missed

This hybrid approach lets the LLM do the bulk of the work while you maintain full control over the final annotations.

## Keyboard Shortcuts

The tool supports keyboard shortcuts for faster annotation:

| Key | Action |
|-----|--------|
| `←` `→` | Previous / next report |
| `j` / `k` | Next / previous sentence |
| `a` | Accept the top pending finding |
| `r` | Reject the top pending finding |
| `f` | Focus the finding search box |
| `n` | Jump to next unvalidated report |
| `?` | Show all keyboard shortcuts |

Press `?` at any time within the tool to see the complete shortcut reference.

## Frequently Asked Questions

**Where is my data stored?**
In your browser's local storage (IndexedDB). It persists between sessions — you can close the browser and come back later. However, clearing your browser data will erase it, so export your work regularly.

**Can I save my progress and come back later?**
Yes. Your work is saved automatically in the browser. You can also export a full session backup (JSON file) from the sidebar and restore it later, even on a different computer.

**What format does my CSV need to be in?**
A standard CSV file with a header row. At minimum, it needs one column with a unique ID for each report and one column with the report text. The tool will let you map your columns during upload. UTF-8 encoding is recommended.

**Can I use this for non-chest-X-ray reports?**
The finding taxonomy is currently specific to chest X-rays. The tool interface itself is modality-agnostic, but the built-in taxonomy won't cover findings from other imaging types.

**What browsers are supported?**
Any modern browser: Chrome, Firefox, Safari, or Edge. The tool requires JavaScript and IndexedDB support (enabled by default in all modern browsers).

**Can multiple people annotate the same reports?**
Each person can annotate independently in their own browser. The tool doesn't have built-in multi-user or inter-annotator comparison features, but you can export each person's annotations and compare them externally.

---

## For Developers

<details>
<summary>Technical details (click to expand)</summary>

### Tech Stack

- **Alpine.js** — reactive UI framework
- **Dexie.js** — IndexedDB wrapper for local persistence
- **PapaParse** — CSV parsing
- **Tailwind CSS** (Play CDN) — styling
- **Tabler Icons** — iconography

### Local Development

```bash
python3 -m http.server 8501
# Open http://localhost:8501
```

### Architecture

```
/
├── index.html          # Entry point (Alpine.js app)
├── css/app.css         # Custom styles
├── js/
│   ├── app.js          # Core app logic
│   ├── storage.js      # IndexedDB wrapper
│   ├── taxonomy.js     # Finding taxonomy search/matching
│   ├── sentences.js    # Report text parsing
│   ├── actionability.js # Actionability resolution
│   └── csv-import.js   # Extraction CSV import
└── data/               # Static JSON (generated externally)
    ├── taxonomy.json         # 324 findings with categories and synonyms
    ├── attributes.json       # Attribute definitions
    ├── actionability-rules.json
    ├── normality-mappings.json
    └── sample-reports.json
```

### Data Generation

The `data/` JSON files are generated externally from the [Open Imaging Finding Model (OIFM)](https://github.com/openimagingdata/findingmodels) taxonomy.

</details>

## Author

Created by [Michael Hood](https://github.com/hoodcm) as part of the [Open Imaging Data Model (OIDM)](https://github.com/openimagingdata) initiative.

## License

MIT — Copyright (c) 2026 Michael Hood

/**
 * Derive a display label for the active taxonomy from its CSV filename.
 *
 * Workbench filenames are lowercase-hyphenated (e.g. ct-head-findings-taxonomy.csv).
 * A plain Title Case pass would render imaging-modality acronyms as "Ct" / "Xr"
 * / "Mri", which reads as sloppy. The allowlist below upper-cases tokens that
 * are known acronyms; everything else gets Title Case.
 */
const EXAM_TYPE_ACRONYMS = new Set([
  'ct', 'cta', 'cr',
  'mr', 'mri', 'mra', 'mrv', 'mrcp',
  'xr', 'cxr', 'kub', 'ivp',
  'us',
  'pet', 'spect', 'nm',
  'dxa', 'dexa', 'oct',
  'msk', 'ercp',
]);

function deriveExamType(filename) {
  return filename
    .replace(/\.csv$/i, '')
    .replace(/-findings-taxonomy$/i, '')
    .split('-')
    .map(s => {
      if (!s) return s;
      if (EXAM_TYPE_ACRONYMS.has(s.toLowerCase())) return s.toUpperCase();
      if (s.toUpperCase() === s) return s;
      return s.charAt(0).toUpperCase() + s.slice(1);
    })
    .join(' ');
}

window.deriveExamType = deriveExamType;

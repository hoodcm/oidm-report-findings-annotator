/**
 * Hand-curated report fixtures for parse/match contract tests.
 *
 * Each fixture exercises a different shape the splitter must handle. Kept
 * small enough that the expected sentence array reads inline — when a test
 * fails the diff is obvious. Do NOT regenerate these from the production
 * report corpus; that defeats their purpose.
 *
 * The shape is the input that `Sentences.splitIntoSentences` receives at
 * runtime — i.e. the FINDINGS body, not the raw report (parseFindingsSection
 * runs upstream). Expected sentences are exactly what the splitter should
 * produce, in order; expected matches list a few source_text spans the
 * matcher should resolve to a known 1-based index.
 */

const FIXTURES = [
  {
    id: 'bulleted-single-section',
    findingsText:
      'Brain Parenchyma: - No acute infarct. - No mass effect. - No midline shift.',
    expectedSentences: [
      'Brain Parenchyma: - No acute infarct.',
      'Brain Parenchyma: - No mass effect.',
      'Brain Parenchyma: - No midline shift.',
    ],
    expectedMatches: [
      { sourceText: 'No acute infarct', expectedIdx: 1 },
      { sourceText: 'No mass effect', expectedIdx: 2 },
      { sourceText: 'No midline shift', expectedIdx: 3 },
    ],
  },
  {
    id: 'bare-header-propagation',
    findingsText:
      'Brain Parenchyma:\n- Small chronic infarct in the right basal ganglia.\n- No acute infarct.\nVentricular System:\n- Ventricles are normal in size.',
    expectedSentences: [
      'Brain Parenchyma: - Small chronic infarct in the right basal ganglia.',
      'Brain Parenchyma: - No acute infarct.',
      'Ventricular System: - Ventricles are normal in size.',
    ],
    expectedMatches: [
      { sourceText: 'Small chronic infarct in the right basal ganglia', expectedIdx: 1 },
      { sourceText: 'Ventricles are normal in size', expectedIdx: 3 },
    ],
  },
  {
    id: 'inline-header-content',
    findingsText:
      'Brain Parenchyma: No acute hemorrhage. No mass effect.\nVentricular System: Normal in size and configuration.',
    expectedSentences: [
      'Brain Parenchyma: No acute hemorrhage.',
      'Brain Parenchyma: No mass effect.',
      'Ventricular System: Normal in size and configuration.',
    ],
    expectedMatches: [
      { sourceText: 'No acute hemorrhage', expectedIdx: 1 },
      { sourceText: 'No mass effect', expectedIdx: 2 },
      { sourceText: 'Normal in size and configuration', expectedIdx: 3 },
    ],
  },
  {
    id: 'templated-none-kept',
    findingsText:
      'Brain Parenchyma: No acute findings.\nHemorrhage: none.\nMass Effect: none.',
    expectedSentences: [
      'Brain Parenchyma: No acute findings.',
      'Hemorrhage: none.',
      'Mass Effect: none.',
    ],
    expectedMatches: [
      { sourceText: 'No acute findings', expectedIdx: 1 },
      { sourceText: 'Hemorrhage: none.', expectedIdx: 2 },
    ],
  },
  {
    id: 'asterisk-bullets-multi-section',
    findingsText:
      'Brain Parenchyma:\n* No acute infarct.\n* No hemorrhage.\nVentricular System:\n* Ventricles are normal.\n* No hydrocephalus.',
    expectedSentences: [
      'Brain Parenchyma: * No acute infarct.',
      'Brain Parenchyma: * No hemorrhage.',
      'Ventricular System: * Ventricles are normal.',
      'Ventricular System: * No hydrocephalus.',
    ],
    expectedMatches: [
      { sourceText: 'No acute infarct', expectedIdx: 1 },
      { sourceText: 'No hemorrhage', expectedIdx: 2 },
      { sourceText: 'Ventricles are normal', expectedIdx: 3 },
      { sourceText: 'No hydrocephalus', expectedIdx: 4 },
    ],
  },
];

if (typeof module !== 'undefined') module.exports = { FIXTURES };
if (typeof window !== 'undefined') window.__REPORT_FIXTURES = FIXTURES;

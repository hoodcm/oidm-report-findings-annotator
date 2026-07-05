/**
 * Tests for js/sentences.js — splitter, source-text matcher, merge key.
 */

describe('Sentences.parseFindingsSection — section boundary detection', () => {
  it('captures FINDINGS body up to IMPRESSION header', () => {
    const text = 'FINDINGS: a. b.\nIMPRESSION: c.';
    assertEqual(Sentences.parseFindingsSection(text), 'a. b.');
  });

  it('does not truncate on lowercase "impression" inside body (regression: was "mild")', () => {
    const text = 'FINDINGS: mild impression on the thecal sac.\nIMPRESSION: see above.';
    assertEqual(Sentences.parseFindingsSection(text), 'mild impression on the thecal sac.');
  });

  it('does not truncate on uppercase "IMPRESSIONABLE" inside body', () => {
    const text = 'FINDINGS: IMPRESSIONABLE finding here.\nIMPRESSION: above.';
    assertEqual(Sentences.parseFindingsSection(text), 'IMPRESSIONABLE finding here.');
  });

  it('returns the rest when no IMPRESSION header is present', () => {
    const text = 'FINDINGS: a. b.';
    assertEqual(Sentences.parseFindingsSection(text), 'a. b.');
  });

  it('accepts lowercase "Impression:" header on its own line', () => {
    const text = 'FINDINGS: a. b.\nImpression: c.';
    assertEqual(Sentences.parseFindingsSection(text), 'a. b.');
  });

  // --- Robust out-of-scope screening (v1.6+): strip IMPRESSION/CONCLUSION on
  // every branch, colon-optional, by the locked boundary rule (all-caps
  // anywhere OR line-start any case, word-boundaried). ---

  it('strips IMPRESSION with no colon (leak fix — was capturing the whole impression)', () => {
    const text = 'FINDINGS: Lung clear.\nIMPRESSION\nNo acute finding.';
    assertEqual(Sentences.parseFindingsSection(text), 'Lung clear.');
  });

  it('strips an all-caps IMPRESSION appearing inline (no line break, no colon)', () => {
    const text = 'FINDINGS: Lung clear. IMPRESSION Small nodule.';
    assertEqual(Sentences.parseFindingsSection(text), 'Lung clear.');
  });

  it('strips a CONCLUSION header', () => {
    const text = 'FINDINGS: a. b.\nCONCLUSION: c.';
    assertEqual(Sentences.parseFindingsSection(text), 'a. b.');
  });

  it('strips a capitalized "Conclusions:" header on its own line', () => {
    const text = 'FINDINGS: a. b.\nConclusions: c. d.';
    assertEqual(Sentences.parseFindingsSection(text), 'a. b.');
  });

  it('strips a capitalized "Conclusion" header even without a colon (line-start)', () => {
    const text = 'FINDINGS: Lung clear.\nConclusion\nNo acute process.';
    assertEqual(Sentences.parseFindingsSection(text), 'Lung clear.');
  });

  it('returns empty string for an impression-only report (preserves empty-state contract)', () => {
    const text = 'IMPRESSION: see above.';
    assertEqual(Sentences.parseFindingsSection(text), '');
  });

  it('strips IMPRESSION on a body with no FINDINGS token', () => {
    const text = 'Lung clear.\nIMPRESSION: none.';
    assertEqual(Sentences.parseFindingsSection(text), 'Lung clear.');
  });

  it('does not truncate on a lowercase "conclusion" mid-body (false-positive guard)', () => {
    const text = 'FINDINGS: reached the conclusion of the study without incident.\nIMPRESSION: x.';
    assertEqual(Sentences.parseFindingsSection(text), 'reached the conclusion of the study without incident.');
  });

  it('does not truncate a wrapped findings line that STARTS with lowercase "conclusion" (capitalized-header rule)', () => {
    // A soft-wrapped continuation line beginning with the ordinary lowercase
    // word "conclusion" is real findings text, not a section header — it must
    // survive. Only a Capitalized/ALL-CAPS heading truncates.
    const text = 'FINDINGS: There is no evidence to support the prior\nconclusion of hemorrhage in the left lobe.';
    assertEqual(
      Sentences.parseFindingsSection(text),
      'There is no evidence to support the prior\nconclusion of hemorrhage in the left lobe.'
    );
  });

  it('does not truncate a wrapped findings line that STARTS with lowercase "impression"', () => {
    const text = 'FINDINGS: The finding is stable in\nimpression compared to the prior study.';
    assertEqual(
      Sentences.parseFindingsSection(text),
      'The finding is stable in\nimpression compared to the prior study.'
    );
  });
});

describe('Sentences.splitIntoSentences — period + uppercase splits', () => {
  it('splits two sentences in a single line on period + space + capital', () => {
    const { sentences } = Sentences.splitIntoSentences('No acute hemorrhage. No mass effect.');
    assertEqual(sentences.length, 2);
    assertIncludes(sentences[0], 'No acute hemorrhage');
    assertIncludes(sentences[1], 'No mass effect');
  });

  it('joins continuation lines with a space', () => {
    const { sentences } = Sentences.splitIntoSentences('No acute\nhemorrhage.');
    assertEqual(sentences.length, 1);
    assertEqual(sentences[0], 'No acute hemorrhage.');
  });

  it('blank lines flush the section run', () => {
    const { sentences } = Sentences.splitIntoSentences('Sentence one.\n\nSentence two.');
    assertEqual(sentences.length, 2);
  });
});

describe('Sentences.splitIntoSentences — bullet markers', () => {
  it('splits on `. -` (dash bullet)', () => {
    const text = 'FINDINGS:\nBrain Parenchyma: - Finding 1. - Finding 2. - Finding 3.';
    const { sentences } = Sentences.splitIntoSentences(text);
    assertEqual(sentences.length, 3, 'expected three bullet sentences');
  });

  it('splits on `. *` (asterisk bullet) — B7 fix', () => {
    const text = 'FINDINGS:\nBrain Parenchyma: * Finding 1. * Finding 2. * Finding 3.';
    const { sentences } = Sentences.splitIntoSentences(text);
    assertEqual(sentences.length, 3, 'expected three asterisk-bullet sentences (regression: was 1)');
  });

  it('splits at boundaries before numbered items (1., 2., ...)', () => {
    // The splitter fires on every ". X" boundary where X starts with a capital
    // (or with `\d+. Capital`). For single-line numbered lists this means the
    // number prefix can land in its own fragment — a known limitation; the
    // splitter is tuned for multi-sentence prose, not packed enumerations.
    const text = '1. First impression. 2. Second impression.';
    const { sentences } = Sentences.splitIntoSentences(text);
    assert(sentences.length >= 2, 'at least the two impressions appear');
  });

  it('does NOT split on `. +` (plus marker, intentionally unsupported)', () => {
    const text = 'A: + Finding 1. + Finding 2.';
    const { sentences } = Sentences.splitIntoSentences(text);
    // `+` is not in the bullet character class so it doesn't trigger a split
    assertEqual(sentences.length, 1);
  });
});

describe('Sentences.splitIntoSentences — headers and section prefixes', () => {
  it('prefixes section header onto each sentence', () => {
    const text = 'Brain: Finding 1. Finding 2.';
    const { sentences } = Sentences.splitIntoSentences(text);
    assert(sentences[0].startsWith('Brain:'), 'first sentence should carry header prefix');
    assert(sentences[1].startsWith('Brain:'), 'second sentence should carry header prefix');
  });

  it('keeps a templated "Header: none" placeholder as an ordinary sentence', () => {
    // A templated null gets the same treatment as "Unremarkable." / "Normal."
    // — sentence numbering stays aligned with the raw report and the line
    // stays quotable by an extractor.
    const text = 'Brain: none.';
    const { sentences } = Sentences.splitIntoSentences(text);
    assertDeepEqual(sentences, ['Brain: none.']);
  });

  it('treats colons >60 chars as not-a-header', () => {
    const text = 'A very long phrase that is more than sixty characters and shouldnt be treated as a header: content here.';
    const { sentences } = Sentences.splitIntoSentences(text);
    // Whole thing becomes one sentence content (no header treatment)
    assertEqual(sentences.length, 1);
  });
});

describe('Sentences._normForMatch', () => {
  it('lowercases and collapses whitespace', () => {
    assertEqual(Sentences._normForMatch('  Hello   World  '), 'hello world');
  });

  it('strips a trailing period', () => {
    assertEqual(Sentences._normForMatch('Hello.'), 'hello');
  });

  it('handles null/undefined gracefully', () => {
    assertEqual(Sentences._normForMatch(null), '');
    assertEqual(Sentences._normForMatch(undefined), '');
    assertEqual(Sentences._normForMatch(''), '');
  });
});

describe('Sentences.matchSourceToSentence — 1-based indexing', () => {
  it('returns 1-based index for a single match (first sentence is 1, not 0)', () => {
    const sentences = ['Brain: apples here.', 'Brain: oranges here.', 'Brain: pears here.'];
    const r = Sentences.matchSourceToSentence('apples', sentences, 'r1', []);
    assertEqual(r.idx, 1, 'first sentence is index 1');
  });

  it('returns correct index for the third sentence', () => {
    const sentences = ['Mentions apples.', 'Mentions oranges.', 'Mentions pears.'];
    const r = Sentences.matchSourceToSentence('pears', sentences, 'r1', []);
    assertEqual(r.idx, 3);
  });

  it('returns ambiguous error when text matches multiple sentences', () => {
    const sentences = ['A appears here.', 'A appears here.'];
    const r = Sentences.matchSourceToSentence('A appears here', sentences, 'r1', []);
    assertEqual(r.error, 'ambiguous');
    assertEqual(r.matches.length, 2);
  });

  it('returns not_in_report when no sentence matches', () => {
    const sentences = ['Only this sentence.'];
    const r = Sentences.matchSourceToSentence('Different text', sentences, 'r1', []);
    assertEqual(r.error, 'not_in_report');
  });

  it('finds the text in another report when not in named one (cross-attribution diagnostic)', () => {
    const sentences = ['Only this sentence.'];
    const otherReport = { record_id: 'r2', sentences: ['Different text appears here.'] };
    const r = Sentences.matchSourceToSentence('Different text', sentences, 'r1', [otherReport]);
    assertEqual(r.error, 'not_in_report');
    assertDeepEqual(r.alsoMatchesIn, ['r2']);
  });

  it('case-insensitive match', () => {
    const sentences = ['Brain: Hello World.'];
    const r = Sentences.matchSourceToSentence('hello world', sentences, 'r1', []);
    assertEqual(r.idx, 1);
  });
});

describe('Sentences.matchSourceToSentence — closest-sentence suggestion (D4)', () => {
  // Templated-normal report fixture: two near-identical sibling sentences
  // (only the laterality word differs) + one distinctly unique sentence.
  const TEMPLATED = [
    'Left kidney is normal in size and echogenicity.',
    'Right kidney is normal in size and echogenicity.',
    'There is a 2 cm hypoechoic lesion in the spleen.',
  ];

  it("SHOULDN'T fire: a laterality-free paraphrase is genuinely ambiguous between near-identical siblings (margin gate)", () => {
    const r = Sentences.matchSourceToSentence('Kidney shows normal size and echogenicity.', TEMPLATED, 'r1', []);
    assertEqual(r.error, 'not_in_report');
    assertEqual(r.suggestion, null, 'top-1 vs top-2 margin is ~0 between the two identical-scoring siblings');
  });

  it('MUST fire: a paraphrase of the one distinctly unique sentence clears both the floor and the margin', () => {
    const r = Sentences.matchSourceToSentence('There is a 2cm hypoechoic lesion within the spleen.', TEMPLATED, 'r1', []);
    assertEqual(r.error, 'not_in_report');
    assert(r.suggestion, 'suggestion should fire');
    assertEqual(r.suggestion.idx, 3);
    assert(r.suggestion.score >= Sentences.SUGGESTION_FLOOR);
  });

  it('a crossAttributed row (exact match in ANOTHER report) still gets a same-report fuzzy candidate at the matcher level — suppression is the caller\'s job', () => {
    // Paraphrase of the unique spleen sentence would fuzzy-suggest idx 3 in
    // the named report; the text ALSO appears verbatim in another loaded
    // report, which is the strong record_id-mix-up signal (alsoMatchesIn).
    const otherReport = { record_id: 'r2', sentences: ['There is a 2cm hypoechoic lesion within the spleen.'] };
    const r = Sentences.matchSourceToSentence('There is a 2cm hypoechoic lesion within the spleen.', TEMPLATED, 'r1', [otherReport]);
    assertEqual(r.error, 'not_in_report');
    assertDeepEqual(r.alsoMatchesIn, ['r2']);
    assert(r.suggestion, 'the matcher itself still computes the candidate unconditionally');
    assertEqual(r.suggestion.idx, 3);
    // The suppression-on-crossAttributed contract lives one layer up, in
    // CsvImport.validateExtractionRows (js/extraction-import.js), which
    // never surfaces a suggestion on a row it buckets as crossAttributed
    // (alsoMatchesIn.length > 0) — covered in extraction-import.test.js.
  });

  it('two-sentence span: a quote straddling a sentence boundary suggests the HEAD sentence (the one where the quote starts)', () => {
    const sentences = [
      'A fracture line extends to the articular',
      'surface with a small step-off deformity.',
    ];
    const r = Sentences.matchSourceToSentence('extends to the articular surface with a small step-off', sentences, 'r1', []);
    assertEqual(r.error, 'not_in_report');
    assertEqual(r.suggestion.idx, 1, 'suggests sentence 1, which contains the head of the quote');
    assertEqual(r.suggestion.score, 1);
  });

  it('empty source_text yields no suggestion', () => {
    const r = Sentences.matchSourceToSentence('', TEMPLATED, 'r1', []);
    assertEqual(r.suggestion, null);
  });
});

describe('Sentences.mergeKey — B4 stable merge identity', () => {
  it('produces identical keys for same source_text + finding (case/whitespace insensitive)', () => {
    const a = Sentences.mergeKey('Brain: Hello world.', 'Cerebral edema');
    const b = Sentences.mergeKey('  brain: hello   world  ', 'CEREBRAL EDEMA');
    assertEqual(a, b, 'normalized inputs should produce same key');
  });

  it('produces different keys for different source_texts', () => {
    const a = Sentences.mergeKey('text one', 'x');
    const b = Sentences.mergeKey('text two', 'x');
    assert(a !== b);
  });

  it('produces different keys for different finding names', () => {
    const a = Sentences.mergeKey('text', 'finding one');
    const b = Sentences.mergeKey('text', 'finding two');
    assert(a !== b);
  });

  it('handles null/undefined inputs', () => {
    const k = Sentences.mergeKey(null, undefined);
    assertEqual(k, '::');
  });

  it('strips trailing period in source_text', () => {
    const a = Sentences.mergeKey('Hello world.', 'x');
    const b = Sentences.mergeKey('Hello world', 'x');
    assertEqual(a, b);
  });
});

describe('Sentences.splitSentenceHeader', () => {
  it('splits "Header: content" into [header, content]', () => {
    const [h, c] = Sentences.splitSentenceHeader('Brain: Hello world.');
    assertEqual(h, 'Brain:');
    assertEqual(c, 'Hello world.');
  });

  it('returns empty header for a sentence with no header', () => {
    const [h, c] = Sentences.splitSentenceHeader('Just a sentence.');
    assertEqual(h, '');
    assertEqual(c, 'Just a sentence.');
  });
});

describe('Sentences.splitIntoSentences — templated-none edge cases', () => {
  it('keeps "Header:none" with no space after the colon (space normalized)', () => {
    const { sentences } = Sentences.splitIntoSentences('Hemorrhage:none');
    assertDeepEqual(sentences, ['Hemorrhage: none']);
  });

  it('keeps "Header: None." with trailing period', () => {
    const { sentences } = Sentences.splitIntoSentences('Hemorrhage: None.');
    assertDeepEqual(sentences, ['Hemorrhage: None.']);
  });
});

describe('Sentences.isFirstOfHeaderRun — v1.3.0 header-rendering fix', () => {
  // Pins the boundary-keyed predicate that drives sub-section header rendering.
  // The bug it replaced suppressed headers across most reports because the gate
  // fired only when a sectionBreaks entry coincided with the sentence index.
  it('returns true at the first sentence of each same-prefix run', () => {
    const text = 'Brain Parenchyma:\n- A.\n- B.\nVentricular System:\n- C.';
    const { sentences } = Sentences.splitIntoSentences(text);
    assertEqual(Sentences.isFirstOfHeaderRun(sentences, 0), true);
    assertEqual(Sentences.isFirstOfHeaderRun(sentences, 1), false);
    assertEqual(Sentences.isFirstOfHeaderRun(sentences, 2), true);
  });

  it('returns false for sentences with no header prefix', () => {
    const sentences = ['Just a sentence.', 'Another sentence.'];
    assertEqual(Sentences.isFirstOfHeaderRun(sentences, 0), false);
    assertEqual(Sentences.isFirstOfHeaderRun(sentences, 1), false);
  });

  it('returns false for out-of-range indices', () => {
    const sentences = ['Brain: A.'];
    assertEqual(Sentences.isFirstOfHeaderRun(sentences, -1), false);
    assertEqual(Sentences.isFirstOfHeaderRun(sentences, 5), false);
  });
});

// Intentionally NOT tested: abbreviation handling (e.g. "Dr. Smith reported X.").
// The splitter currently fires on every `. CapitalLetter` boundary regardless
// of whether the preceding token is an abbreviation. This is a known limitation
// in the same class as the packed-numbered-impressions case above. Tests would
// either pin broken behavior or fail until the splitter learns abbreviations —
// neither is a useful regression signal today.

describe('Sentences.splitIntoSentences — flattened line breaks (2026-07-05 forensics)', () => {
  // Real-world shape: a reports CSV whose newlines were flattened to runs of
  // spaces by a spreadsheet round-trip. Without space-run normalization the
  // whole FINDINGS body is one line and the first section header glues onto
  // EVERY sentence ("Devices/Tubes/Lines: Pleura: No pleural effusions.").
  const FLAT = 'Devices/Tubes/Lines: none    Lungs: Lungs are clear.    Pleura: No pleural effusions.    Bones/Soft Tissues: Degenerative changes.';

  it('recovers per-section sentences from a single flattened line (no header glue)', () => {
    const { sentences } = Sentences.splitIntoSentences(FLAT);
    assertDeepEqual(sentences, [
      'Devices/Tubes/Lines: none',
      'Lungs: Lungs are clear.',
      'Pleura: No pleural effusions.',
      'Bones/Soft Tissues: Degenerative changes.',
    ]);
  });

  it('keeps a flattened "Header: none" as an ordinary sentence (numbering aligned with raw report)', () => {
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(FLAT);
    assertEqual(sentences[0], 'Devices/Tubes/Lines: none');
    assertDeepEqual(sectionBreaks, [], 'a templated null is a sentence, not an invented empty subheader');
  });

  it('handles a 2-space-flattened blob (no newlines anywhere)', () => {
    const { sentences } = Sentences.splitIntoSentences('Lungs: Clear.  Pleura: No effusion.');
    assertDeepEqual(sentences, ['Lungs: Clear.', 'Pleura: No effusion.']);
  });

  it('a typographic double space after a period yields the same sentences as before', () => {
    const { sentences } = Sentences.splitIntoSentences('Heart: Normal size.  No effusion.');
    assertDeepEqual(sentences, ['Heart: Normal size.', 'Heart: No effusion.']);
  });

  it('a mid-sentence double space in a MULTI-LINE report does not split the sentence', () => {
    const { sentences } = Sentences.splitIntoSentences('Lungs: The heart is  normal in size.\nPleura: Clear.');
    assertEqual(sentences.length, 2);
    assertEqual(sentences[1], 'Pleura: Clear.');
  });
});

describe('Sentences.matchSourceToSentence — multi-sentence quotes and out-of-scope (2026-07-05 forensics)', () => {
  const SENTENCES = [
    'Lungs: There is no evidence of pneumonia or pulmonary edema.',
    'Pleura: No pleural effusion or pneumothorax.',
    'Bones: Degenerative changes of the thoracic spine.',
  ];
  const RAW = 'FINDINGS Lungs: There is no evidence of pneumonia or pulmonary edema. Pleura: No pleural effusion or pneumothorax. Bones: Degenerative changes of the thoracic spine. IMPRESSION No radiographic evidence of pneumonia. Stable degenerative changes of the spine.';

  it('anchors a FINDINGS+IMPRESSION stitched quote to the findings sentence (spannedPieces)', () => {
    const q = 'There is no evidence of pneumonia or pulmonary edema. No radiographic evidence of pneumonia.';
    const r = Sentences.matchSourceToSentence(q, SENTENCES, 'r1', [], RAW);
    assertEqual(r.idx, 1);
    assertEqual(r.spannedPieces, 2);
  });

  it('anchors a quote stitched from two findings sentences to the first uniquely-matching piece', () => {
    const q = 'No pleural effusion or pneumothorax. Degenerative changes of the thoracic spine.';
    const r = Sentences.matchSourceToSentence(q, SENTENCES, 'r1', [], RAW);
    assertEqual(r.idx, 2);
    assertEqual(r.spannedPieces, 2);
  });

  it('reports out_of_scope (not not_in_report) for a verbatim IMPRESSION-only quote', () => {
    const r = Sentences.matchSourceToSentence('No radiographic evidence of pneumonia.', SENTENCES, 'r1', [], RAW);
    assertEqual(r.error, 'out_of_scope');
  });

  it('without reportText an impression quote degrades to not_in_report (legacy callers)', () => {
    const r = Sentences.matchSourceToSentence('No radiographic evidence of pneumonia.', SENTENCES, 'r1', []);
    assertEqual(r.error, 'not_in_report');
  });

  it('a stitched quote with one piece verbatim NOWHERE does not match', () => {
    const q = 'No pleural effusion or pneumothorax. The lungs are hyperexpanded bilaterally.';
    const r = Sentences.matchSourceToSentence(q, SENTENCES, 'r1', [], RAW);
    assert(!r.idx, 'must not anchor when a piece is hallucinated');
  });

  it('flags templated boilerplate (found in 3+ other reports) so callers keep the suggestion', () => {
    const others = ['r2', 'r3', 'r4'].map(id => ({ record_id: id, sentences: ['No pneumothorax.'] }));
    const r = Sentences.matchSourceToSentence('No pneumothorax.', SENTENCES, 'r1', others, RAW);
    assertEqual(r.error, 'not_in_report');
    assertEqual(r.boilerplate, true);
    assertEqual(r.alsoMatchesIn.length, 3);
  });

  it('does NOT flag boilerplate for 1-2 other reports (genuine record_id mix-up signal)', () => {
    const others = [{ record_id: 'r2', sentences: ['No pneumothorax.'] }];
    const r = Sentences.matchSourceToSentence('No pneumothorax.', SENTENCES, 'r1', others, RAW);
    assertEqual(r.error, 'not_in_report');
    assertEqual(r.boilerplate, false);
  });
});

describe('Sentences._reconstructLines — generalized collapse recovery (subheaders must render)', () => {
  it('single-space collapse: header after a period starts its own line', () => {
    const { sentences } = Sentences.splitIntoSentences('Lungs: Clear. Pleura: No effusions. Heart: Normal.');
    assertDeepEqual(sentences, ['Lungs: Clear.', 'Pleura: No effusions.', 'Heart: Normal.']);
  });

  it('single-space collapse: header after a templated "none" starts its own line', () => {
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences('Devices/Tubes/Lines: none Lungs: Clear. Pleura: No effusions.');
    assertDeepEqual(sentences, ['Devices/Tubes/Lines: none', 'Lungs: Clear.', 'Pleura: No effusions.']);
    assertDeepEqual(sectionBreaks, []);
  });

  it('REAL-newline report with several sections on one line still yields per-section sentences', () => {
    const { sentences } = Sentences.splitIntoSentences('Comparison: None. Lungs: Clear.\nPleura: No effusions.');
    assertDeepEqual(sentences, ['Comparison: None.', 'Lungs: Clear.', 'Pleura: No effusions.']);
  });

  it('does not split a sentence at an ordinary period followed by a plain capitalized word', () => {
    const { sentences } = Sentences.splitIntoSentences('Lungs: Clear. The heart is normal.');
    assertDeepEqual(sentences, ['Lungs: Clear.', 'Lungs: The heart is normal.']);
  });

  it('parseFindingsSection strips a mixed-case Impression that was collapsed onto the findings line', () => {
    const body = Sentences.parseFindingsSection('EXAMINATION  Chest radiograph  FINDINGS  Lungs: Clear.  Impression: No acute disease.');
    const { sentences } = Sentences.splitIntoSentences(body);
    assertDeepEqual(sentences, ['Lungs: Clear.'], 'impression content must not become annotatable');
  });
});

describe('Sentences — section vs subheader classification (2026-07-05 header-style fix)', () => {
  // Contract from real report styling: large section headers (HEAD:,
  // CERVICAL SPINE:) are ALL-CAPS and bare — label alone, content below.
  // Subheaders (Lungs:, Devices/Tubes/Lines:) are mixed-case; a templated
  // null value ("Header: none") is ordinary sentence content, never a break.
  it('ALL-CAPS bare header is a large section divider (sub: false)', () => {
    const text = 'HEAD:\nBrain Parenchyma: No midline shift.\nCERVICAL SPINE:\nAlignment and Vertebrae: Intact.';
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences(text);
    assertDeepEqual(sentences, ['Brain Parenchyma: No midline shift.', 'Alignment and Vertebrae: Intact.']);
    assertDeepEqual(sectionBreaks, [
      { before: 0, header: 'HEAD:', sub: false },
      { before: 1, header: 'CERVICAL SPINE:', sub: false },
    ]);
  });

  it('"Header: none" is an ordinary sentence in report order, not a break — any case', () => {
    const mixed = Sentences.splitIntoSentences('Heart/Mediastinum: none\nBones/Soft Tissues: Rib fractures.');
    assertDeepEqual(mixed.sentences, ['Heart/Mediastinum: none', 'Bones/Soft Tissues: Rib fractures.']);
    assertDeepEqual(mixed.sectionBreaks, []);
    const caps = Sentences.splitIntoSentences('LINES AND TUBES: none\nLungs: Clear.');
    assertDeepEqual(caps.sentences, ['LINES AND TUBES: none', 'Lungs: Clear.']);
    assertDeepEqual(caps.sectionBreaks, []);
  });

  it('a trailing "Header: none" stays in the sentence list (numbering intact)', () => {
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences('Lungs: Clear.\nBones/Soft Tissues: none');
    assertDeepEqual(sentences, ['Lungs: Clear.', 'Bones/Soft Tissues: none']);
    assertDeepEqual(sectionBreaks, []);
  });

  it('mixed-case bare header is a subheader break (its content arrives on following lines)', () => {
    const { sectionBreaks } = Sentences.splitIntoSentences('Right:\nExternal Ear: Normal.\nLeft:\nExternal Ear: Unremarkable.');
    assertDeepEqual(sectionBreaks, [
      { before: 0, header: 'Right:', sub: true },
      { before: 1, header: 'Left:', sub: true },
    ]);
  });

  it('a trailing bare header break sits at sentences.length so the renderer can show it', () => {
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences('Lungs: Clear.\nBones/Soft Tissues:');
    assertEqual(sentences.length, 1);
    assertDeepEqual(sectionBreaks, [{ before: 1, header: 'Bones/Soft Tissues:', sub: true }]);
  });
});

describe('Sentences.isSubBreak / breaksBefore — render-side classification and dedup', () => {
  it('isSubBreak honors an explicit sub flag', () => {
    assertEqual(Sentences.isSubBreak({ header: 'HEAD:', sub: true }), true);
    assertEqual(Sentences.isSubBreak({ header: 'Pleura:', sub: false }), false);
  });

  it('isSubBreak classifies legacy flag-less breaks (stored sessions) by label case', () => {
    assertEqual(Sentences.isSubBreak({ header: 'Devices/Tubes/Lines:' }), true);
    assertEqual(Sentences.isSubBreak({ header: 'HEAD:' }), false);
  });

  it('breaksBefore returns breaks at the given index, including trailing ones', () => {
    const report = {
      sentences: ['Lungs: Clear.'],
      sectionBreaks: [
        { before: 0, header: 'Devices/Tubes/Lines:', sub: true },
        { before: 1, header: 'Bones/Soft Tissues:', sub: true },
      ],
    };
    assertDeepEqual(Sentences.breaksBefore(report, 0).map(b => b.header), ['Devices/Tubes/Lines:']);
    assertDeepEqual(Sentences.breaksBefore(report, 1).map(b => b.header), ['Bones/Soft Tissues:']);
  });

  it('breaksBefore drops a subheader break whose header the next sentence carries as prefix (no double render)', () => {
    const { sentences, sectionBreaks } = Sentences.splitIntoSentences('Brain Parenchyma:\n- No hemorrhage.\n- No mass.');
    const report = { sentences, sectionBreaks };
    assertEqual(sentences[0].startsWith('Brain Parenchyma:'), true);
    assertDeepEqual(Sentences.breaksBefore(report, 0), [], 'inline header run already renders this label');
  });

  it('breaksBefore keeps a large section divider even when the next sentence carries its prefix', () => {
    const report = {
      sentences: ['HEAD: No acute hemorrhage.'],
      sectionBreaks: [{ before: 0, header: 'HEAD:', sub: false }],
    };
    assertDeepEqual(Sentences.breaksBefore(report, 0).map(b => b.header), ['HEAD:']);
  });
});

/**
 * Tests for js/sentences.js — splitter, source-text matcher, merge key.
 */

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

  it('skips templated "Header: none" placeholders', () => {
    const text = 'Brain: none.';
    const { sentences } = Sentences.splitIntoSentences(text);
    assertEqual(sentences.length, 0);
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

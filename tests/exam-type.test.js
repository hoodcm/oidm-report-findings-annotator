/**
 * Tests for js/exam-type.js — taxonomy filename → display label.
 *
 * Regression: before this fix, lowercase modality acronyms (ct, xr, mri, ...)
 * rendered as Title Case ("Ct Head", "Msk Xr"). See CHANGELOG [Unreleased].
 */

describe('deriveExamType — modality acronyms render uppercase', () => {
  it('ct-head-findings-taxonomy.csv → "CT Head"', () => {
    assertEqual(deriveExamType('ct-head-findings-taxonomy.csv'), 'CT Head');
  });

  it('msk-xr-findings-taxonomy.csv → "MSK XR"', () => {
    assertEqual(deriveExamType('msk-xr-findings-taxonomy.csv'), 'MSK XR');
  });

  it('mri-brain-findings-taxonomy.csv → "MRI Brain"', () => {
    assertEqual(deriveExamType('mri-brain-findings-taxonomy.csv'), 'MRI Brain');
  });

  it('cxr-findings-taxonomy.csv → "CXR"', () => {
    assertEqual(deriveExamType('cxr-findings-taxonomy.csv'), 'CXR');
  });

  it('us-abdomen-findings-taxonomy.csv → "US Abdomen"', () => {
    assertEqual(deriveExamType('us-abdomen-findings-taxonomy.csv'), 'US Abdomen');
  });
});

describe('deriveExamType — non-acronym tokens get Title Case', () => {
  it('head-findings-taxonomy.csv → "Head"', () => {
    assertEqual(deriveExamType('head-findings-taxonomy.csv'), 'Head');
  });

  it('mixed-case tokens are preserved when already uppercase', () => {
    assertEqual(deriveExamType('PET-CT-findings-taxonomy.csv'), 'PET CT');
  });
});

describe('deriveExamType — strips suffix/extension regardless of case', () => {
  it('case-insensitive .csv strip', () => {
    assertEqual(deriveExamType('ct-head-findings-taxonomy.CSV'), 'CT Head');
  });

  it('case-insensitive -findings-taxonomy strip', () => {
    assertEqual(deriveExamType('CT-HEAD-Findings-Taxonomy.csv'), 'CT HEAD');
  });

  it('filename without the conventional suffix is passed through', () => {
    assertEqual(deriveExamType('ct-head.csv'), 'CT Head');
  });
});

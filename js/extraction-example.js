/**
 * Shared worked example for the LLM extraction prompt, the playbook page,
 * and the round-trip fixture test. One synthetic, exam-neutral mini-report
 * (FINDINGS section only) + its exact extraction JSON + commentary notes.
 *
 * Single source of truth: the prompt's worked example and the importer's
 * contract are the same fixture, so the two cannot silently drift apart
 * (a prompt change or an importer change that breaks the pairing fails the
 * round-trip test in tests/extraction-import.test.js).
 *
 * Coverage (per the design plan's D2 checklist):
 *   - a hedged finding (confidence as a JSON object)
 *   - a multi-value axis (chronicity, two values on one row)
 *   - an aggregate boolean, paired with a characterized discrete member
 *     sharing the same finding_name
 *   - a discrete-split pair (two individually-sited instances from one
 *     sentence)
 *   - one custom (non-canonical) attribute ("margin")
 */
const ExtractionExample = {
  // Full report text, in the same shape a real report record's `report_text`
  // takes (a FINDINGS: header the real pipeline strips via
  // Sentences.parseFindingsSection before splitting into sentences).
  report: `FINDINGS:

Fractures are seen involving the 6th rib on the left and the 9th rib on the right. Multiple scattered pulmonary nodules are again noted, too numerous to count individually. The largest measures 4 mm in the right upper lobe with spiculated margins. A possible focus of mixed old and recent hemorrhage is seen along the anterior mediastinum.`,

  // Synthetic record_id — never the ID the LLM should emit on real data
  // (the prompt's worked example says so explicitly).
  recordId: 'EXAMPLE-0001',

  findings: [
    // Discrete-split pair: one sentence names two individually-sited
    // fractures, so it becomes two rows sharing a finding_name.
    {
      record_id: 'EXAMPLE-0001',
      finding_name: 'rib_fracture',
      presence: 'present',
      source_text: 'Fractures are seen involving the 6th rib on the left and the 9th rib on the right.',
      laterality: 'left',
      anatomic_site: '6th rib',
    },
    {
      record_id: 'EXAMPLE-0001',
      finding_name: 'rib_fracture',
      presence: 'present',
      source_text: 'Fractures are seen involving the 6th rib on the left and the 9th rib on the right.',
      laterality: 'right',
      anatomic_site: '9th rib',
    },
    // Aggregate row: a plural mention with no per-instance distinguishing
    // detail (a bare "too numerous to count") gets ONE row, aggregate=true.
    {
      record_id: 'EXAMPLE-0001',
      finding_name: 'pulmonary_nodule',
      presence: 'present',
      source_text: 'Multiple scattered pulmonary nodules are again noted, too numerous to count individually.',
      aggregate: 'true',
      temporal_status: 'unchanged',
    },
    // Characterized index member of the SAME finding_name: this one has its
    // own size, site, and margin, so it earns its own discrete row alongside
    // the aggregate row above. Also carries the one custom (non-canonical)
    // attribute: "margin" isn't in attributes.json.
    {
      record_id: 'EXAMPLE-0001',
      finding_name: 'pulmonary_nodule',
      presence: 'present',
      source_text: 'The largest measures 4 mm in the right upper lobe with spiculated margins.',
      laterality: 'right',
      anatomic_site: 'right upper lobe',
      size: '4 mm',
      margin: 'spiculated',
    },
    // Hedged + multi-value chronicity: "possible" hedges presence; "mixed
    // old and recent" sets two chronicity values on one row, not two rows.
    {
      record_id: 'EXAMPLE-0001',
      finding_name: 'mediastinal_hemorrhage',
      presence: 'present',
      source_text: 'A possible focus of mixed old and recent hemorrhage is seen along the anterior mediastinum.',
      anatomic_site: 'anterior mediastinum',
      extent: 'small',
      chronicity: ['acute', 'chronic'],
      confidence: { presence: 'hedged' },
    },
  ],

  // Commentary shown alongside the worked example (tier 3 of the prompt,
  // and the playbook page's example section). One representative note per
  // axis the example demonstrates.
  notes: [
    'Laterality / anatomic_site — "Fractures ... the 6th rib on the left and the 9th rib on the right" names two individually sited instances, so it becomes two rows, not one aggregate row.',
    'Aggregate vs. discrete — "too numerous to count" has no per-instance distinguishing detail, so it’s one row with aggregate="true"; the very next sentence characterizes one specific nodule and becomes its own discrete row sharing the same finding_name.',
    'Custom attributes — "margin" isn’t one of the listed fields. The annotator keeps it as a free-text custom attribute instead of dropping it.',
    'Chronicity is multi-value — "mixed old and recent hemorrhage" sets chronicity to two values (["acute","chronic"]) on the same row, not two separate rows.',
    'Hedged vs. definite — "a possible focus ... favored to represent" is a presence hedge (confidence={"presence":"hedged"}); the fractures and nodules above are stated as definite, so they carry no confidence key at all.',
    'Extent vs. severity — "a possible focus" also sets extent="small"; extent (physical size) and severity (clinical intensity) are separate axes even when a sentence blurs them.',
  ],
};

window.ExtractionExample = ExtractionExample;

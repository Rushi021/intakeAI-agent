/** Parse and index the study IR. Schema is documented in data/README.md. */

export const CANONICAL_TYPES = [
  'text', 'textarea', 'integer', 'decimal', 'date', 'time', 'datetime',
  'boolean', 'single_select', 'multi_select', 'radio', 'checkbox', 'calculated',
] as const;
export type FieldType = (typeof CANONICAL_TYPES)[number];

export type Option = { code: string; label: string };
export type Field = {
  label: string;
  type: FieldType;
  required: boolean;
  options?: Option[];
  min?: number;
  max?: number;
  units?: string;
  formula?: string;
  skip_logic?: { when_field_label: string; equals_value: string };
};
export type Form = { name: string; repeating: boolean; fields: Field[] };
export type Visit = { name: string; window_start_day: number; window_end_day: number; forms: Form[] };
export type IR = {
  ir_version: string;
  study: { protocol_id: string; title: string };
  visits: Visit[];
};

export function parseIR(text: string): IR {
  const ir = JSON.parse(text) as IR;
  const bad = (m: string) => {
    throw new Error(`input file is not a study IR: ${m}`);
  };
  if (!ir?.study?.protocol_id) bad('missing study.protocol_id');
  if (!Array.isArray(ir.visits) || ir.visits.length === 0) bad('no visits');
  for (const v of ir.visits) {
    if (!v.name) bad('a visit has no name');
    for (const f of v.forms ?? []) {
      if (!f.name) bad(`a form under "${v.name}" has no name`);
      for (const fl of f.fields ?? []) {
        if (!fl.label) bad(`a field in "${f.name}" has no label`);
        if (!CANONICAL_TYPES.includes(fl.type)) bad(`unknown type "${fl.type}" on "${fl.label}"`);
      }
    }
  }
  return ir;
}

/** Counts for the UI, and for the recall check at the end of a run. */
export function stats(ir: IR) {
  const forms = ir.visits.flatMap((v) => v.forms);
  const fields = forms.flatMap((f) => f.fields);
  return {
    visits: ir.visits.length,
    formAppearances: forms.length,
    distinctForms: new Set(forms.map((f) => JSON.stringify(f))).size,
    fields: fields.length,
    skipRules: fields.filter((f) => f.skip_logic).length,
    repeatingForms: forms.filter((f) => f.repeating).length,
  };
}

/**
 * The model plans against this, not the full 195 fields — names only. Field
 * detail is fetched per form when that form is actually being built.
 */
export function skeleton(ir: IR) {
  return {
    study: ir.study,
    visits: ir.visits.map((v) => ({
      name: v.name,
      window: [v.window_start_day, v.window_end_day],
      forms: v.forms.map((f) => ({ name: f.name, repeating: f.repeating, fieldCount: f.fields.length })),
    })),
  };
}

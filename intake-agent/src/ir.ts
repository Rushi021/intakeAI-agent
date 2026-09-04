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
    distinctForms: new Set(forms.map(formKey)).size,
    fields: fields.length,
    skipRules: fields.filter((f) => f.skip_logic).length,
    repeatingForms: forms.filter((f) => f.repeating).length,
  };
}

// ---------------------------------------------------------------------------
// The plan — what the agent is trying to build, in the order it can be built.
// ---------------------------------------------------------------------------

export type PlanItem =
  | { id: string; kind: 'visit'; visit: Visit }
  | { id: string; kind: 'form'; visit: string; form: Form; key: string }
  | { id: string; kind: 'field'; visit: string; form: string; field: Field };

/**
 * A stable structural key for a form definition. Key-order independent, so two
 * IR forms that mean the same thing hash the same — which is what the reuse
 * decision rests on. JSON.stringify would not be: it is key-order sensitive,
 * which is harmless for a count and not harmless for "are these two the same
 * form".
 */
export function formKey(f: Form): string {
  const field = (fl: Field) =>
    [
      fl.label,
      fl.type,
      fl.required ? 'req' : '',
      (fl.options ?? []).map((o) => `${o.code}=${o.label}`).join(','),
      fl.min ?? '',
      fl.max ?? '',
      fl.units ?? '',
      fl.formula ?? '',
      fl.skip_logic ? `${fl.skip_logic.when_field_label}=${fl.skip_logic.equals_value}` : '',
    ].join('|');
  return [f.name, f.repeating ? 'rep' : '', ...f.fields.map(field)].join('\n');
}

/** formKey → its occurrences across the study, in plan order. */
export function recurring(ir: IR): Map<string, PlanItem[]> {
  const out = new Map<string, PlanItem[]>();
  for (const item of planItems(ir)) {
    if (item.kind !== 'form') continue;
    const seen = out.get(item.key);
    if (seen) seen.push(item);
    else out.set(item.key, [item]);
  }
  return out;
}

/**
 * Fields dependency-ordered inside their form: a field whose skip_logic names a
 * controller is emitted after that controller, because the rule cannot be set
 * against a field that does not exist yet.
 *
 * Kahn's algorithm, IR order as the tiebreak, so ordering is stable and mostly
 * unchanged. A cycle (none expected in the 13 rules) emits the remainder in IR
 * order and lets the skip-logic sub-step escalate rather than deadlock.
 */
export function orderFields(fields: Field[]): Field[] {
  const byLabel = new Map(fields.map((f) => [f.label, f]));
  const done = new Set<string>();
  const out: Field[] = [];

  let progress = true;
  while (out.length < fields.length && progress) {
    progress = false;
    for (const f of fields) {
      if (done.has(f.label)) continue;
      const dep = f.skip_logic?.when_field_label;
      if (dep && byLabel.has(dep) && !done.has(dep)) continue; // controller not placed yet
      out.push(f);
      done.add(f.label);
      progress = true;
    }
  }
  for (const f of fields) if (!done.has(f.label)) out.push(f); // cycle: escalate, never deadlock
  return out;
}

/**
 * Visits, then the forms under each, then the fields under each form.
 *
 * `id` is the path — "Screening/Demographics/Date of Birth". It is the
 * traceability key (points at one entry in the input file), the idempotency
 * key, and the ledger key. One identifier, three jobs.
 */
export function planItems(ir: IR): PlanItem[] {
  const out: PlanItem[] = [];
  for (const visit of ir.visits) {
    out.push({ id: visit.name, kind: 'visit', visit });
    for (const form of visit.forms) {
      out.push({ id: `${visit.name}/${form.name}`, kind: 'form', visit: visit.name, form, key: formKey(form) });
      for (const field of orderFields(form.fields)) {
        out.push({
          id: `${visit.name}/${form.name}/${field.label}`,
          kind: 'field',
          visit: visit.name,
          form: form.name,
          field,
        });
      }
    }
  }
  return out;
}

/** The visit/form an item has to be inside before it can be built. */
export function contextOf(item: PlanItem): { visit?: string; form?: string } {
  if (item.kind === 'visit') return {};
  if (item.kind === 'form') return { visit: item.visit };
  return { visit: item.visit, form: item.form };
}

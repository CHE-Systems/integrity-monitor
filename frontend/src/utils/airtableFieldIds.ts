/**
 * Heuristic: Airtable field IDs are strings starting with "fld" + alphanumeric.
 */
export function isProbablyAirtableFieldId(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return false;
  const s = String(value).trim();
  return /^fld[A-Za-z0-9]{8,}$/.test(s);
}

/**
 * For required_field / value_check rules stored with the ID in `field` and no `field_id`.
 * Does not resolve names (async); only fixes the shape so ID lives in `field_id`.
 */
export function normalizeRequiredFieldRuleShape(
  data: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...data };
  const f = String(next.field ?? "").trim();
  const fid = String(next.field_id ?? "").trim();

  if (isProbablyAirtableFieldId(f)) {
    next.field_id = fid || f;
  }

  return next;
}

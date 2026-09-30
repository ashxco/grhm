/** Request contracts shared by the checker and generated server. */
export interface InputSpec {
  name: string;
  type: 'string' | 'number' | 'boolean';
  optional: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  integer?: boolean;
  format?: 'email' | 'uuid' | 'url';
}
export function fieldErrors(field: InputSpec, value: unknown): string[] {
  const errors: string[] = [];
  if (value === undefined || value === null) return field.optional ? [] : ['missing required field "' + field.name + '" (' + field.type + ')'];
  if (typeof value !== field.type || (typeof value === 'number' && !Number.isFinite(value))) return ['field "' + field.name + '" must be a ' + field.type];
  if (typeof value === 'number') {
    if (field.integer && !Number.isSafeInteger(value)) errors.push('must be a safe integer');
    if (field.min !== undefined && value < field.min) errors.push('must be at least ' + field.min);
    if (field.max !== undefined && value > field.max) errors.push('must be at most ' + field.max);
  }
  if (typeof value === 'string') {
    if (value.length < (field.minLength ?? 0)) errors.push('is too short');
    if (value.length > (field.maxLength ?? 65_536)) errors.push('is too long');
    if (field.format === 'email' && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) errors.push('must be an email address');
    if (field.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) errors.push('must be a UUID');
    if (field.format === 'url') {
      try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) errors.push('must be an HTTP(S) URL without credentials'); }
      catch { errors.push('must be an HTTP(S) URL'); }
    }
  }
  return errors.map((error) => 'field "' + field.name + '" ' + error);
}
export function validateInput(spec: InputSpec[], body: unknown): { errors: string[]; values: Record<string, unknown> } {
  const errors: string[] = [];
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { errors: ['request body must be a JSON object'], values };
  const record = body as Record<string, unknown>;
  for (const field of spec) {
    const value = Object.hasOwn(record, field.name) ? record[field.name] : undefined;
    errors.push(...fieldErrors(field, value));
    if (value !== undefined && value !== null) values[field.name] = value;
  }
  for (const key of Object.keys(record)) if (!spec.some((field) => field.name === key)) errors.push('unknown field "' + key + '"');
  return { errors, values };
}

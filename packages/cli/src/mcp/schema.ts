/**
 * The JSON Schema subset the tool input schemas use, and a validator for it:
 * enough to turn a wrong argument into a clear tool error the model can fix,
 * without a schema library.
 */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  default?: unknown;
}

function typeOk(type: JsonSchema['type'], v: unknown): boolean {
  switch (type) {
    case undefined:
      return true;
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array':
      return Array.isArray(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    default:
      return typeof v === type;
  }
}

/** Every way `value` breaks `schema`, as `path: problem` strings; empty when it conforms. */
export function validateArgs(schema: JsonSchema, value: unknown, at = ''): string[] {
  const where = at || 'arguments';
  if (!typeOk(schema.type, value)) return [`${where} must be ${schema.type === 'integer' ? 'an integer' : `a ${schema.type}`}`];
  const out: string[] = [];
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    out.push(`${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push(`${where} needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
    }
    if (schema.items) value.forEach((item, i) => out.push(...validateArgs(schema.items!, item, `${where}[${i}]`)));
  }
  if (schema.type === 'object' && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) out.push(`${at ? `${at}.` : ''}${key} is required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const prop = props[key];
      if (!prop) {
        if (schema.additionalProperties === false) {
          out.push(`unknown property ${at ? `${at}.` : ''}${key} (expected: ${Object.keys(props).join(', ') || 'none'})`);
        }
        continue;
      }
      if (v === undefined || v === null) continue; // null means "not given", like an omitted flag
      out.push(...validateArgs(prop, v, `${at ? `${at}.` : ''}${key}`));
    }
  }
  return out;
}

/** `args` with each omitted (or null) top-level property set to its schema default, and nulls dropped. */
export function applyDefaults(schema: JsonSchema, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(args)) if (v !== null && v !== undefined) out[key] = v;
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (out[key] === undefined && prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}

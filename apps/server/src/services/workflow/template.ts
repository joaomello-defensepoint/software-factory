/** Tiny mustache-like renderer: {{a.b}}, {{#if a.b}}…{{else}}…{{/if}}. Values are stringified; objects/arrays become JSON. */
export function renderTemplate(template: string, ctx: Record<string, unknown>): string {
  const lookup = (path: string): unknown => path.split('.').reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), ctx);
  const str = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? `- ${x}` : `- ${JSON.stringify(x)}`)).join('\n');
    if (typeof v === 'object') return JSON.stringify(v, null, 2);
    return String(v);
  };
  const truthy = (v: unknown): boolean => !!v && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'string' && v.trim() === '');

  // Resolve conditionals first (innermost-first, iterate until stable).
  const ifRe = /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/;
  let out = template;
  for (let i = 0; i < 50 && ifRe.test(out); i++) {
    out = out.replace(ifRe, (_m, path: string, yes: string, no?: string) => (truthy(lookup(path)) ? yes : (no ?? '')));
  }
  return out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => str(lookup(path)));
}

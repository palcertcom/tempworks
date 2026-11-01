/**
 * Pseudo-localization helper.
 *
 * When the active locale is `pseudo` (only enabled in development), every
 * translated string is wrapped in `[!! … !!]` and ASCII letters are
 * "accented" with diacritics. This makes:
 *   1. Hardcoded English strings stand out (they appear without brackets).
 *   2. Layouts that don't accommodate longer strings break visibly
 *      (the wrapper grows the string by ~30%).
 *
 * Activate by selecting "Pseudo" in the language switcher in dev, or by
 * calling `i18n.changeLanguage('pseudo')` from the console.
 */

const ACCENT_MAP: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'đ', e: 'é', f: 'ƒ', g: 'ǵ', h: 'ĥ',
  i: 'í', j: 'ǰ', k: 'ķ', l: 'ļ', m: 'ḿ', n: 'ñ', o: 'ó', p: 'ṕ',
  q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ',
  y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ǵ', H: 'Ĥ',
  I: 'Í', J: 'J̌', K: 'Ķ', L: 'Ļ', M: 'Ḿ', N: 'Ñ', O: 'Ó', P: 'Ṕ',
  Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ',
  Y: 'Ý', Z: 'Ž',
};

/**
 * Wrap and accent a string. Preserves i18next interpolation tokens
 * (`{{name}}`) and plural-related braces so interpolation still works.
 */
export function pseudoize(input: string): string {
  if (!input) return input;
  const parts = input.split(/(\{\{[^}]+\}\})/g);
  const transformed = parts
    .map((p) =>
      p.startsWith('{{') ? p : p.replace(/[a-zA-Z]/g, (ch) => ACCENT_MAP[ch] ?? ch),
    )
    .join('');
  return `[!! ${transformed} !!]`;
}

/**
 * Build a pseudo-translation tree by walking any other locale's resource
 * tree and pseudoizing every leaf string. Used to register the `pseudo`
 * resource bundle when i18n initializes (dev only).
 */
export function pseudoizeTree(value: unknown): unknown {
  if (typeof value === 'string') return pseudoize(value);
  if (Array.isArray(value))      return value.map(pseudoizeTree);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = pseudoizeTree(v);
    return out;
  }
  return value;
}

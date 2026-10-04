export const DEFAULT_CONFIG = Object.freeze({
  defaultLocale: 'zh-CN',
  localeDirs: Object.freeze(['src/locales', 'src/i18n', 'locales', 'i18n']),
  inlayHints: Object.freeze({ enabled: true, maxLength: 24 }),
  packages: Object.freeze([]),
});

export const CONFIG_RELATIVE_PATH = '.zed/i18nlensrc.json';

export function resolveConfigPath(workspaceRoot) {
  return joinFsPath(normalizeFsPath(workspaceRoot), CONFIG_RELATIVE_PATH);
}

export function normalizeI18nLensConfig(raw = {}) {
  const base = normalizeProjectConfig(raw, DEFAULT_CONFIG);
  const packages = Array.isArray(raw.packages)
    ? raw.packages
      .map((pkg) => normalizePackageConfig(pkg, base))
      .filter(Boolean)
    : [];

  return { ...base, packages };
}

export function mergeI18nLensConfig(base = {}, override = {}) {
  return {
    ...base,
    ...override,
    inlayHints: {
      ...((base && typeof base.inlayHints === 'object') ? base.inlayHints : {}),
      ...((override && typeof override.inlayHints === 'object') ? override.inlayHints : {}),
    },
    packages: Array.isArray(override?.packages) ? override.packages : base?.packages,
  };
}

function normalizeProjectConfig(raw = {}, defaults = DEFAULT_CONFIG) {
  const defaultLocale = typeof raw.defaultLocale === 'string' && raw.defaultLocale.trim()
    ? raw.defaultLocale.trim()
    : defaults.defaultLocale;

  const localeDirs = Array.isArray(raw.localeDirs)
    ? raw.localeDirs.filter((dir) => typeof dir === 'string' && dir.trim()).map((dir) => normalizeRelativePath(dir.trim()))
    : [];

  const defaultInlayHints = defaults.inlayHints || DEFAULT_CONFIG.inlayHints;
  const rawInlayHints = raw.inlayHints && typeof raw.inlayHints === 'object' ? raw.inlayHints : {};
  const enabled = typeof rawInlayHints.enabled === 'boolean' ? rawInlayHints.enabled : defaultInlayHints.enabled;
  const maxLength = Number.isInteger(rawInlayHints.maxLength) && rawInlayHints.maxLength > 0
    ? rawInlayHints.maxLength
    : defaultInlayHints.maxLength;

  return {
    defaultLocale,
    localeDirs: localeDirs.length > 0 ? localeDirs : [...defaults.localeDirs],
    inlayHints: { enabled, maxLength },
  };
}

function normalizePackageConfig(raw, inherited) {
  if (!raw || typeof raw !== 'object') return undefined;
  const root = typeof raw.root === 'string' && raw.root.trim()
    ? normalizeRelativePath(raw.root.trim())
    : undefined;
  if (!root) return undefined;
  return { root, ...normalizeProjectConfig(raw, inherited) };
}

function normalizeRelativePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
}

export function resolveProjectContext(filePath, workspaceRoot, config) {
  const normalizedWorkspaceRoot = normalizeFsPath(workspaceRoot);
  const normalizedFilePath = normalizeFsPath(filePath);
  const candidates = [
    { root: normalizedWorkspaceRoot, config: withoutPackages(config) },
    ...((config?.packages || []).map((pkg) => ({
      root: normalizeFsPath(joinFsPath(normalizedWorkspaceRoot, pkg.root)),
      config: withoutPackages(pkg),
    }))),
  ];

  return candidates
    .filter((candidate) => isPathInside(normalizedFilePath, candidate.root))
    .sort((a, b) => b.root.length - a.root.length)[0] || candidates[0];
}

function withoutPackages(config) {
  const { packages: _packages, ...rest } = config || normalizeI18nLensConfig();
  return rest;
}

function normalizeFsPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/g, '');
}

function joinFsPath(root, relative) {
  return root + '/' + normalizeRelativePath(relative || '');
}

function isPathInside(filePath, root) {
  return filePath === root || filePath.startsWith(root + '/');
}


export function didWatchedFileChange(previous, current) {
  return previous?.mtimeMs !== current?.mtimeMs;
}

export function flattenLocale(value, prefix = '', out = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? prefix + '.' + key : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flattenLocale(child, fullKey, out);
    else out[fullKey] = String(child);
  }
  return out;
}

export function getValueByKey(obj, key) {
  return key.split('.').reduce((acc, part) => (acc && Object.prototype.hasOwnProperty.call(acc, part) ? acc[part] : undefined), obj);
}

function offsetToPosition(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

function makeRange(text, start, end) {
  return { start: offsetToPosition(text, start), end: offsetToPosition(text, end) };
}
// Lexical mask over mixed Vue/TS/JSX text: returns the sorted ranges that are
// NOT real code — comments, plain strings, template-literal raw text, HTML
// comments, and ordinary (non-directive) attribute values. Vue directive
// attribute values (`:x="…"`, `v-x="…"`, `@x="…"`, `#x="…"`) and `${…}`
// interpolations inside template literals stay transparent so real
// expressions inside them are still scanned. Best-effort lexing only — no AST.
function computeOpaqueRanges(text) {
  const ranges = [];
  const stack = [{ type: 'code' }];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < text.length) {
    const f = top();
    const ch = text[i];
    if (f.type === 'lineComment') {
      if (ch === '\n') { ranges.push({ start: f.start, end: i }); stack.pop(); }
      i++;
      continue;
    }
    if (f.type === 'blockComment') {
      if (ch === '*' && text[i + 1] === '/') { ranges.push({ start: f.start, end: i + 2 }); stack.pop(); i += 2; continue; }
      i++;
      continue;
    }
    if (f.type === 'htmlComment') {
      if (ch === '-' && text[i + 1] === '-' && text[i + 2] === '>') { ranges.push({ start: f.start, end: i + 3 }); stack.pop(); i += 3; continue; }
      i++;
      continue;
    }
    if (f.type === 'string') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === f.quote) { ranges.push({ start: f.start, end: i + 1 }); stack.pop(); }
      i++;
      continue;
    }
    if (f.type === 'template') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { ranges.push({ start: f.start, end: i + 1 }); stack.pop(); i++; continue; }
      if (ch === '$' && text[i + 1] === '{') {
        ranges.push({ start: f.start, end: i });
        stack.pop();
        stack.push({ type: 'templateExpr', depth: 0 });
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // code-like frames: code, templateExpr, attrExpr
    if (f.type === 'attrExpr' && f.depth === 0 && ch === f.quote) { stack.pop(); i++; continue; }
    if (ch === '{') {
      if (f.type === 'templateExpr' || f.type === 'attrExpr') f.depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      if (f.type === 'templateExpr') {
        if (f.depth === 0) { stack.pop(); stack.push({ type: 'template', start: i + 1 }); }
        else f.depth--;
      } else if (f.type === 'attrExpr' && f.depth > 0) f.depth--;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') { stack.push({ type: 'lineComment', start: i }); i += 2; continue; }
    if (ch === '/' && text[i + 1] === '*') { stack.push({ type: 'blockComment', start: i }); i += 2; continue; }
    if (ch === '<' && text[i + 1] === '!' && text[i + 2] === '-' && text[i + 3] === '-') { stack.push({ type: 'htmlComment', start: i }); i += 4; continue; }
    if (ch === '"' || ch === "'") {
      if (f.type === 'code' && isAttrExprQuote(text, i)) stack.push({ type: 'attrExpr', quote: ch, depth: 0 });
      else stack.push({ type: 'string', quote: ch, start: i });
      i++;
      continue;
    }
    if (ch === '`') { stack.push({ type: 'template', start: i }); i++; continue; }
    i++;
  }
  while (stack.length > 1) {
    const f = stack.pop();
    if (f.start !== undefined) ranges.push({ start: f.start, end: text.length });
  }
  return ranges;
}

// A quote is a Vue directive attribute opener when preceded by `name=` where
// name is `:foo`, `@foo`, `#foo`, `v-foo`, or `ns:foo` (v-on:, v-bind:, …).
// Plain attributes (`title="…"`, JSX `attr="…"`) keep string semantics.
function isAttrExprQuote(text, quoteOffset) {
  const before = text.slice(Math.max(0, quoteOffset - 200), quoteOffset);
  return /(?:^|[\s<"'`])(?:[:@#][\w.:[\]-]*|[\w-]+:[\w.:[\]-]*|v-[\w.:[\]-]*)\s*=\s*$/.test(before);
}

function isOpaque(ranges, offset) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (offset < r.start) hi = mid - 1;
    else if (offset >= r.end) lo = mid + 1;
    else return true;
  }
  return false;
}


export function extractI18nKeys(text) {
  const found = [];
  const opaque = computeOpaqueRanges(text);
  collectFunctionCallKeys(text, found, opaque);
  collectFormatMessageKeys(text, found, opaque);
  const patterns = [
    // <i18n-t keypath="key"> (Vue I18n) and <Trans i18nKey="key"> (react-i18next)
    /\b(?:keypath|i18nKey)\s*=\s*(['"])([A-Za-z0-9_.:-]+)\1/g,
    /\bv-t\s*=\s*"'([A-Za-z0-9_.:-]+)'"/g,
    /\bv-t\s*=\s*'"([A-Za-z0-9_.:-]+)"'/g,
    /\bv-t\s*=\s*"\s*\{\s*path\s*:\s*(['"])([A-Za-z0-9_.:-]+)\1/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) {
      const before = text[match.index - 1];
      // Literal attribute only — bound directives (`:keypath`, `@`, `#`, `.prop`)
      // hold expressions handled by the call scanner, not a literal key.
      if (before !== undefined && /[\w:@#.-]/.test(before)) continue;
      if (isOpaque(opaque, match.index)) continue;
      const key = match[2] || match[1];
      const keyOffsetInMatch = match[0].lastIndexOf(key);
      const start = match.index + keyOffsetInMatch;
      const end = start + key.length;
      found.push({ key, range: makeRange(text, start, end), startOffset: start, endOffset: end });
    }
  }
  found.sort((a, b) => a.startOffset - b.startOffset);
  return found;
}

function collectFunctionCallKeys(text, found, opaque) {
  // t/$t/tc/$tc/i18n.t/i18n.tc(...) — function calls, incl. Vue I18n plural tc
  const re = /(?:\x24tc?|\btc?|\bi18n\.tc?)\s*\(/g;
  let match;
  while ((match = re.exec(text))) {
    const parenOffset = re.lastIndex - 1;
    if (/[\w$]/.test(text[match.index - 1] || '')) continue;
    if (isOpaque(opaque, match.index)) continue;
    const callText = readParens(text, parenOffset);
    if (!callText) continue;
    // First arg must be exactly one string literal — dynamic keys like
    // `t('prefix.' + name)` are skipped, never half-matched.
    const keyMatch = callText.match(/^\(\s*(['"])([A-Za-z0-9_.:-]+)\1(?=\s*[,)])/);
    if (!keyMatch) continue;
    const key = keyMatch[2];
    const start = parenOffset + keyMatch[0].indexOf(key);
    const end = start + key.length;
    const args = splitArgsWithOffsets(callText.slice(1, -1));
    const paramsEdit = getParamsEdit(args.slice(1), parenOffset + 1, parenOffset + callText.length - 1);
    const paramsObject = extractParamsObject(args.slice(1), parenOffset + 1);
    found.push({ key, range: makeRange(text, start, end), startOffset: start, endOffset: end, providedParams: collectParamNames(args.slice(1)), paramsEdit, paramsObject });
  }
}

function collectFormatMessageKeys(text, found, opaque) {
  const re = /\bformatMessage\s*\(/g;
  let match;
  while ((match = re.exec(text))) {
    if (/[\w$]/.test(text[match.index - 1] || '')) continue;
    if (isOpaque(opaque, match.index)) continue;
    const parenOffset = re.lastIndex - 1;
    const callText = readParens(text, parenOffset);
    if (!callText) continue;
    const args = splitArgsWithOffsets(callText.slice(1, -1));
    const idArg = args[0]?.text || '';
    const keyMatch = idArg.match(/\bid\s*:\s*(['"])([A-Za-z0-9_.:-]+)\1(?=\s*[,}])/);
    if (!keyMatch) continue;
    const key = keyMatch[2];
    const start = parenOffset + 1 + args[0].start + keyMatch.index + keyMatch[0].lastIndexOf(key);
    const end = start + key.length;
    const paramsEdit = getParamsEdit(args.slice(1), parenOffset + 1, parenOffset + callText.length - 1);
    const paramsObject = extractParamsObject(args.slice(1), parenOffset + 1);
    found.push({ key, range: makeRange(text, start, end), startOffset: start, endOffset: end, providedParams: collectParamNames(args.slice(1)), paramsEdit, paramsObject });
  }
}

// Read a balanced (...) starting at `start`.
function readParens(text, start) {
  if (text[start] !== '(') return undefined;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2);
      if (end < 0) return undefined;
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return undefined;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function splitArgs(text) {
  const args = [];
  let start = 0, depth = 0, quote = '', escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const last = text.slice(start).trim();
  if (last) args.push(last);
  return args;
}

function splitArgsWithOffsets(text) {
  const args = [];
  let start = 0, depth = 0, quote = '', escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { args.push(trimArg(text, start, i)); start = i + 1; }
  }
  const last = trimArg(text, start, text.length);
  if (last.text) args.push(last);
  return args;
}

function trimArg(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { text: text.slice(start, end), start, end };
}

function getParamsEdit(args, argsStartOffset, closingParenOffset) {
  const objectArg = args.find((arg) => arg.text.startsWith('{') && arg.text.lastIndexOf('}') > 0);
  if (objectArg) {
    const closeBrace = objectArg.text.lastIndexOf('}');
    let insertAt = closeBrace;
    while (insertAt > 1 && /\s/.test(objectArg.text[insertAt - 1])) insertAt--;
    const body = objectArg.text.slice(1, insertAt);
    return { insertOffset: argsStartOffset + objectArg.start + insertAt, prefix: body.trim() ? ', ' : ' ' };
  }
  return { insertOffset: closingParenOffset, prefix: ', { ', suffix: ' }' };
}

function collectParamNames(args) {
  const params = new Set();
  for (const arg of args) {
    const trimmed = (typeof arg === 'string' ? arg : arg.text).trim();
    if (!trimmed.startsWith('{')) continue;
    const body = trimmed.slice(1, trimmed.lastIndexOf('}'));
    for (const part of splitArgs(body)) {
      const name = paramNameOf(part);
      if (name) params.add(name);
    }
  }
  return [...params].sort();
}

function paramNameOf(part) {
  const trimmed = String(part).trim();
  if (trimmed.startsWith('...')) return undefined;
  const m = trimmed.match(/^(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*(?::|$)/);
  return (m && (m[1] || m[2])) || undefined;
}

// Absolute span of the params object literal plus each top-level property's raw
// text, so a code action can rebuild the object with unused params removed.
function extractParamsObject(args, argsStartOffset) {
  const objectArg = args.find((arg) => arg.text.startsWith('{') && arg.text.lastIndexOf('}') > 0);
  if (!objectArg) return undefined;
  const start = argsStartOffset + objectArg.start;
  const body = objectArg.text.slice(1, objectArg.text.lastIndexOf('}'));
  const props = splitArgsWithOffsets(body).map((part) => ({ name: paramNameOf(part.text), text: part.text }));
  return { start, end: start + objectArg.text.length, props };
}

export function keyAtPosition(text, position) {
  const offset = positionToOffset(text, position);
  return extractI18nKeys(text).find((item) => item.startOffset <= offset && offset <= item.endOffset);
}

// Reverse of Go to Definition: every range in `text` (source code) that uses `key`.
export function findCodeKeyRanges(text, key) {
  return extractI18nKeys(text).filter((item) => item.key === key).map((item) => item.range);
}

export function positionToOffset(text, position) {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < position.line; i++) offset += (lines[i] || '').length + 1;
  return offset + position.character;
}


export function collectLocaleWatchPaths(localeCache, localeDirs = []) {
  const paths = new Set(localeDirs.filter(Boolean));
  for (const locale of Object.values(localeCache || {})) {
    if (locale.path) paths.add(locale.path);
    for (const file of locale.files || []) paths.add(file);
  }
  return [...paths].sort();
}

export function findLocaleKeyTarget(locale, key, localeTexts = {}) {
  if (!locale || !Object.prototype.hasOwnProperty.call(locale.flat || {}, key)) return undefined;
  const files = Array.isArray(locale.files) && locale.files.length
    ? locale.files
    : (locale.path ? [locale.path] : []);
  const candidates = files
    .map((filePath) => ({ filePath, lookupKey: lookupKeyForLocaleFile(locale, filePath, key) }))
    .sort((a, b) => Number(a.lookupKey === key) - Number(b.lookupKey === key));

  for (const candidate of candidates) {
    const text = localeTexts[candidate.filePath];
    if (!text) continue;
    const range = localeKeyRange(text, candidate.lookupKey, /\.json$/i.test(candidate.filePath));
    if (range) return { filePath: candidate.filePath, position: range.start, range };
  }

  const fallback = candidates[0];
  return fallback ? { filePath: fallback.filePath } : undefined;
}

function lookupKeyForLocaleFile(locale, filePath, key) {
  const isNestedLocaleFile = !locale.topLevelFiles?.includes(filePath) && normalizeFsPath(locale.path) !== normalizeFsPath(filePath);
  const stem = fileStem(filePath);
  if (isNestedLocaleFile && stem && stem !== 'index' && key.startsWith(stem + '.')) return key.slice(stem.length + 1);
  return key;
}

function fileStem(filePath) {
  const fileName = String(filePath || '').replace(/\\/g, '/').split('/').at(-1) || '';
  return fileName.replace(/\.[^.]+$/, '');
}

export function buildHoverMarkdown(key, locales) {
  const names = Object.keys(locales).sort();
  if (names.length === 0) return '**' + key + '**\n\nNo locale JSON files found.';
  const lines = ['**' + key + '**', '', '| Locale | Text |', '|---|---|'];
  for (const name of names) {
    const value = locales[name].flat[key];
    lines.push('| ' + escapeMd(name) + ' | ' + escapeMd(value ?? 'Missing') + ' |');
  }
  return lines.join('\n');
}

function escapeMd(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function getDiagnostics(text, locales) {
  const localeEntries = Object.entries(locales);
  if (localeEntries.length === 0) return [];

  return extractI18nKeys(text).flatMap((item) => {
    const missingLocales = localeEntries
      .filter(([, locale]) => !Object.prototype.hasOwnProperty.call(locale.flat, item.key))
      .map(([name]) => name)
      .sort();

    const diagnostics = [];
    if (missingLocales.length > 0) {
      const missingInAllLocales = missingLocales.length === localeEntries.length;
      diagnostics.push({
        severity: missingInAllLocales ? 1 : 2,
        range: item.range,
        message: missingInAllLocales
          ? 'Missing i18n key: ' + item.key
          : 'Missing i18n key "' + item.key + '" in locales: ' + missingLocales.join(', '),
        source: 'i18n-lens',
        data: { key: item.key, missingLocales, missingInAllLocales },
      });
    }
    if (missingLocales.length !== localeEntries.length) {
      diagnostics.push(...getParamDiagnostics(item, localeEntries));
      const consistency = getLocaleParamConsistency(item.key, locales);
      if (!consistency.consistent) diagnostics.push(paramInconsistencyDiagnostic(item.key, item.range, consistency.perLocale));
    }
    return diagnostics;
  });
}

function getParamDiagnostics(item, localeEntries) {
  if (!Array.isArray(item.providedParams)) return [];
  const required = collectRequiredParams(item.key, localeEntries);
  const provided = new Set(item.providedParams);
  const missing = required.filter((n) => !provided.has(n));
  const unused = item.providedParams.filter((n) => !required.includes(n));
  const diagnostics = [];
  if (missing.length > 0)
    diagnostics.push({ severity: 2, range: item.range, message: 'Missing i18n params for "' + item.key + '": ' + missing.join(', '), source: 'i18n-lens', data: { key: item.key, missingParams: missing } });
  if (unused.length > 0)
    diagnostics.push({ severity: 2, range: item.range, message: 'Unused i18n params for "' + item.key + '": ' + unused.join(', '), source: 'i18n-lens', data: { key: item.key, unusedParams: unused } });
  return diagnostics;
}

function collectRequiredParams(key, localeEntries) {
  const params = new Set();
  for (const [, locale] of localeEntries) {
    const value = locale.flat[key];
    if (value === undefined) continue;
    for (const name of extractPlaceholders(value)) params.add(name);
  }
  return [...params].sort();
}

// Compare the interpolation placeholders a key uses across every locale that
// defines it. `consistent` is false when two locales that both define the key
// carry different param sets (a translation forgot or renamed a placeholder).
// Locales that do not define the key are ignored — that is a missing-key concern.
export function getLocaleParamConsistency(key, locales) {
  const perLocale = [];
  for (const [name, locale] of Object.entries(locales || {})) {
    const value = locale.flat?.[key];
    if (value === undefined) continue;
    perLocale.push({ name, params: extractPlaceholders(value) });
  }
  const union = [...new Set(perLocale.flatMap((entry) => entry.params))].sort();
  const consistent = perLocale.length < 2
    || perLocale.every((entry) => entry.params.length === union.length && union.every((param) => entry.params.includes(param)));
  return { consistent, perLocale, union };
}

// Warnings for keys defined in `locale`'s file whose params disagree with the
// same key in other locales, anchored at each key's position in the file text.
export function getLocaleParamDiagnostics(locale, filePath, text, locales) {
  if (!locale?.flat) return [];
  const isJson = /\.json$/i.test(filePath);
  const jsonRoot = isJson ? parseJsonStructure(text) || null : undefined;
  const diagnostics = [];
  for (const key of Object.keys(locale.flat)) {
    const consistency = getLocaleParamConsistency(key, locales);
    if (consistency.consistent) continue;
    const lookupKey = lookupKeyForLocaleFile(locale, filePath, key);
    const range = localeKeyRange(text, lookupKey, isJson, jsonRoot);
    if (range) diagnostics.push(paramInconsistencyDiagnostic(key, range, consistency.perLocale));
  }
  return diagnostics;
}

function paramInconsistencyDiagnostic(key, range, perLocale) {
  return {
    severity: 2,
    range,
    message: 'i18n params for "' + key + '" differ across locales — ' + formatPerLocaleParams(perLocale),
    source: 'i18n-lens',
    data: { key, paramInconsistency: perLocale },
  };
}

function formatPerLocaleParams(perLocale) {
  return perLocale
    .map((entry) => entry.name + ': ' + (entry.params.length ? entry.params.map((p) => '{' + p + '}').join(', ') : '(none)'))
    .join('; ');
}

export function getParamCodeActions(text, diagnostics = []) {
  const items = extractI18nKeys(text);
  return diagnostics.flatMap((diagnostic) => {
    const item = items.find((candidate) => candidate.key === diagnostic.data?.key && sameRange(candidate.range, diagnostic.range));

    const missingParams = diagnostic.data?.missingParams;
    if (Array.isArray(missingParams) && missingParams.length > 0) {
      if (!item?.paramsEdit) return [];
      const newText = item.paramsEdit.prefix + missingParams.join(', ') + (item.paramsEdit.suffix || '');
      return [{
        title: 'Add missing i18n params: ' + missingParams.join(', '),
        diagnostic,
        edit: { range: makeRange(text, item.paramsEdit.insertOffset, item.paramsEdit.insertOffset), newText },
      }];
    }

    const unusedParams = diagnostic.data?.unusedParams;
    if (Array.isArray(unusedParams) && unusedParams.length > 0) {
      if (!item?.paramsObject) return [];
      const kept = item.paramsObject.props.filter((prop) => !unusedParams.includes(prop.name));
      const rebuilt = kept.length ? '{ ' + kept.map((prop) => prop.text).join(', ') + ' }' : '{}';
      return [{
        title: 'Remove unused i18n params: ' + unusedParams.join(', '),
        diagnostic,
        edit: { range: makeRange(text, item.paramsObject.start, item.paramsObject.end), newText: rebuilt },
      }];
    }

    return [];
  });
}

function sameRange(a, b) {
  return a?.start?.line === b?.start?.line
    && a?.start?.character === b?.start?.character
    && a?.end?.line === b?.end?.line
    && a?.end?.character === b?.end?.character;
}

export function extractPlaceholders(value) {
  const params = new Set();
  // ICU-style: {name, plural, ...} — extract top-level name, skip nested content
  let text = String(value);
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open === -1) break;
    const head = text.slice(open).match(/^\{\s*([A-Za-z_$][\w$]*)\s*,/);
    if (head) {
      params.add(head[1]);
      let depth = 0, i = open;
      while (i < text.length) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      text = text.slice(0, open) + ' '.repeat(i - open + 1) + text.slice(i + 1);
      cursor = open;
      continue;
    }
    cursor = open + 1;
  }
  const re = /\{\s*([A-Za-z_$][\w$]*)\s*\}/g;
  let m;
  while ((m = re.exec(text))) params.add(m[1]);
  return [...params].sort();
}

export function resolvePreferredLocale(locales, defaultLocale) {
  if (!locales || Object.keys(locales).length === 0) return undefined;
  if (locales[defaultLocale]) return locales[defaultLocale];

  const requested = normalizeLocaleName(defaultLocale);
  const entries = Object.entries(locales);
  const exactNormalized = entries.find(([name]) => normalizeLocaleName(name) === requested);
  if (exactNormalized) return exactNormalized[1];

  const requestedLanguage = requested.split('-')[0];
  const languageMatch = entries.find(([name]) => {
    const candidate = normalizeLocaleName(name);
    const candidateLanguage = candidate.split('-')[0];
    return candidateLanguage && requestedLanguage && candidateLanguage === requestedLanguage;
  });
  return languageMatch?.[1] || entries[0][1];
}

function normalizeLocaleName(name) {
  return String(name || '').trim().replace(/_/g, '-').toLowerCase();
}

export function getCompletions(prefix, locales, defaultLocale) {
  const keys = new Set();
  for (const locale of Object.values(locales)) for (const key of Object.keys(locale.flat)) keys.add(key);
  const preferred = resolvePreferredLocale(locales, defaultLocale);
  return [...keys]
    .filter((key) => key.startsWith(prefix))
    .sort()
    .map((key) => ({ label: key, kind: 12, detail: preferred?.flat[key] || undefined, insertText: key }));
}


export function getDefinitionLocaleOrder(locales, defaultLocale) {
  const localeList = Object.values(locales || {});
  const preferred = resolvePreferredLocale(locales, defaultLocale);
  if (!preferred) return localeList;
  return [preferred, ...localeList.filter((locale) => locale !== preferred)];
}

// Every locale that defines the key, with the default locale first, so
// Go to Definition can return one LSP Location per language file.
export function collectLocaleKeyTargets(locales, key, localeTexts = {}, defaultLocale) {
  return getDefinitionLocaleOrder(locales, defaultLocale)
    .map((locale) => findLocaleKeyTarget(locale, key, localeTexts))
    .filter((target) => target?.position);
}

// Inverse of findLocaleKeyTarget: given a caret position inside a locale file,
// return the full flattened key it points at (so Find References can jump back
// to the code). Reuses the same key->location logic as Go to Definition to stay
// consistent; precise for JSON, best-effort (line-based) for TS/JS locale modules.
export function localeKeyAtPosition(locale, filePath, text, position) {
  if (!locale || !locale.flat || !text || !position) return undefined;
  const isJson = /\.json$/i.test(filePath);
  const jsonRoot = isJson ? parseJsonStructure(text) || null : undefined;
  let lineFallback;
  let lineFallbackCount = 0;
  for (const fullKey of Object.keys(locale.flat)) {
    const lookupKey = lookupKeyForLocaleFile(locale, filePath, fullKey);
    const range = localeKeyRange(text, lookupKey, isJson, jsonRoot);
    if (!range || range.start.line !== position.line) continue;
    if (comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) < 0) return fullKey;
    lineFallback = fullKey;
    lineFallbackCount++;
  }
  return !isJson && lineFallbackCount === 1 ? lineFallback : undefined;
}

export function getCompletionPrefix(text, position) {
  const before = text.slice(0, positionToOffset(text, position));
  const opaque = computeOpaqueRanges(before);
  const patterns = [
    /(?:\x24tc?|\btc?|\bi18n\.tc?)\s*\(\s*['"]([A-Za-z0-9_.:-]*)$/,
    /\bformatMessage\s*\(\s*\{[^}]*?\bid\s*:\s*['"]([A-Za-z0-9_.:-]*)$/,
    /\b(?:keypath|i18nKey)\s*=\s*['"]([A-Za-z0-9_.:-]*)$/,
    /\bv-t\s*=\s*"'([A-Za-z0-9_.:-]*)$/,
    /\bv-t\s*=\s*'\x22([A-Za-z0-9_.:-]*)$/,
    /\bv-t\s*=\s*"\s*\{\s*path\s*:\s*['"]([A-Za-z0-9_.:-]*)$/,
  ];
  for (const re of patterns) {
    const match = before.match(re);
    if (!match || isOpaque(opaque, match.index)) continue;
    if (/[\w$:@#-]/.test(before[match.index - 1] || '')) continue;
    return match[1];
  }
  return undefined;
}

export function findJsonKeyLocation(jsonText, key) {
  return localeKeyRange(jsonText, key, true)?.start;
}

function localeKeyRange(text, key, isJson, jsonRoot = isJson ? parseJsonStructure(text) : undefined) {
  if (isJson) {
    const property = findJsonProperty(jsonRoot, key.split('.'));
    return property ? makeRange(text, property.start, property.end) : undefined;
  }
  const start = findLocaleKeyLocation(text, key);
  if (!start) return undefined;
  const offset = positionToOffset(text, start);
  const token = text.slice(offset).match(/^(?:'[^']*'|"[^"]*"|[\w$-]+)/);
  return token ? makeRange(text, offset, offset + token[0].length) : undefined;
}

// JSON.parse validates the grammar; this walk retains property-token and value
// boundaries for edits. Maps avoid prototype keys and duplicate keys are refused.
function parseJsonStructure(text) {
  try { JSON.parse(text); } catch { return undefined; }
  let offset = 0;
  let duplicate = false;
  const whitespace = () => { while (/\s/.test(text[offset] || '') && offset < text.length) offset++; };
  function stringEnd() {
    offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2;
      else if (text[offset++] === '"') break;
    }
  }
  function value() {
    whitespace();
    const start = offset;
    const properties = text[offset] === '{' ? new Map() : undefined;
    if (properties) {
      offset++;
      whitespace();
      while (text[offset] !== '}') {
        const keyStart = offset;
        stringEnd();
        const keyEnd = offset;
        const key = JSON.parse(text.slice(keyStart, keyEnd));
        whitespace();
        offset++; // colon
        const child = value();
        if (properties.has(key)) duplicate = true;
        properties.set(key, { start: keyStart, end: keyEnd, value: child });
        whitespace();
        if (text[offset] !== ',') break;
        offset++;
        whitespace();
      }
      offset++;
    } else if (text[offset] === '[') {
      offset++;
      whitespace();
      while (text[offset] !== ']') {
        value();
        whitespace();
        if (text[offset] !== ',') break;
        offset++;
      }
      offset++;
    } else if (text[offset] === '"') {
      stringEnd();
    } else {
      while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset++;
    }
    return { start, end: offset, properties };
  }
  const root = value();
  return duplicate ? undefined : root;
}

function findJsonProperty(node, parts) {
  if (!node?.properties) return undefined;
  let found;
  for (let count = 1; count <= parts.length; count++) {
    const property = node.properties.get(parts.slice(0, count).join('.'));
    if (!property) continue;
    const candidate = count === parts.length ? property : findJsonProperty(property.value, parts.slice(count));
    if (!candidate) continue;
    if (found) return undefined; // dotted and nested representations collide
    found = candidate;
  }
  return found;
}

// Insert only into an unambiguous object path. Existing scalar/array prefixes,
// duplicate properties and existing values are never overwritten.
export function insertNestedJsonKey(jsonText, key, value = '') {
  let node = parseJsonStructure(jsonText);
  let parts = key.split('.');
  if (!node?.properties || parts.some((part) => !part)) return undefined;
  let depth = 0;
  while (true) {
    const matches = [];
    for (let count = 1; count <= parts.length; count++) {
      const property = node.properties.get(parts.slice(0, count).join('.'));
      if (property) matches.push({ count, property });
    }
    if (!matches.length) break;
    if (matches.length !== 1) return undefined;
    const { count, property } = matches[0];
    if (count === parts.length || !property.value.properties) return undefined;
    parts = parts.slice(count);
    node = property.value;
    depth++;
  }
  const eol = jsonText.includes('\r\n') ? '\r\n' : '\n';
  const unit = detectIndentUnit(jsonText);
  const firstProperty = node.properties.values().next().value;
  const lineStart = firstProperty ? jsonText.lastIndexOf('\n', firstProperty.start) + 1 : -1;
  const existingIndent = firstProperty ? jsonText.slice(lineStart, firstProperty.start) : '';
  const indent = firstProperty && /^[ \t]+$/.test(existingIndent) ? existingIndent : unit.repeat(depth + 1);
  const snippet = buildNestedProperty(parts, value, indent, unit, eol);
  let contentEnd = node.end - 1;
  while (contentEnd > node.start + 1 && /\s/.test(jsonText[contentEnd - 1])) contentEnd--;
  if (!node.properties.size) {
    return jsonText.slice(0, node.start + 1) + eol + snippet + eol + indent.slice(0, -unit.length) + jsonText.slice(node.end - 1);
  }
  return jsonText.slice(0, contentEnd) + ',' + eol + snippet + jsonText.slice(contentEnd);
}

function detectIndentUnit(jsonText) {
  const match = jsonText.match(/\n([ \t]+)\S/);
  return match ? match[1] : '  ';
}

function buildNestedProperty(parts, value, indent, unit, eol) {
  const keyStr = JSON.stringify(parts[0]);
  if (parts.length === 1) return indent + keyStr + ': ' + JSON.stringify(value);
  return indent + keyStr + ': {' + eol + buildNestedProperty(parts.slice(1), value, indent + unit, unit, eol) + eol + indent + '}';
}


export function parseTsLocaleModule(text, fileName = 'index.ts') {
  const result = {};
  const stem = fileName.replace(/\.[cm]?[tj]sx?$/i, '');
  const exportObject = extractObjectAfter(text, /export\s+default\s*/g);
  if (exportObject) {
    Object.assign(result, flattenJsObjectLiteral(exportObject, stem === 'index' ? '' : stem));
  }

  if (stem === 'index') {
    const constRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
    let match;
    while ((match = constRe.exec(text))) {
      const objectStart = text.indexOf('{', match.index);
      const objectText = readBalanced(text, objectStart);
      if (objectText) Object.assign(result, flattenJsObjectLiteral(objectText, match[1]));
    }
  }
  return result;
}

function extractObjectAfter(text, re) {
  const match = re.exec(text);
  if (!match) return undefined;
  const start = text.indexOf('{', match.index + match[0].length);
  if (start === -1) return undefined;
  return readBalanced(text, start);
}

function readBalanced(text, start) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function flattenJsObjectLiteral(objectText, prefix = '', out = {}) {
  const body = objectText.replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,;]/.test(body[i])) i++;
    if (body.startsWith('//', i)) { const end = body.indexOf('\n', i); i = end === -1 ? body.length : end + 1; continue; }
    if (body.startsWith('/*', i)) { const end = body.indexOf('*/', i + 2); i = end === -1 ? body.length : end + 2; continue; }
    const keyMatch = body.slice(i).match(/^(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$-]*))\s*:/);
    if (!keyMatch) { i++; continue; }
    const key = keyMatch[1] || keyMatch[2];
    i += keyMatch[0].length;
    while (i < body.length && /\s/.test(body[i])) i++;
    const fullKey = prefix ? prefix + '.' + key : key;
    if (body[i] === '{') {
      const nested = readBalanced(body, i);
      if (!nested) break;
      flattenJsObjectLiteral(nested, fullKey, out);
      i += nested.length;
      continue;
    }
    const value = readJsValue(body, i);
    if (value) {
      if (value.kind === 'string') out[fullKey] = value.value;
      i = value.end;
    } else i++;
  }
  return out;
}

function readJsValue(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let value = '';
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { value += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === quote) return { kind: 'string', value, end: i + 1 };
    value += ch;
  }
  return undefined;
}

export function findLocaleKeyLocation(text, key) {
  const parts = key.split('.');
  const last = parts[parts.length - 1];
  const re = new RegExp('(?:["\\\']' + escapeRegExp(last) + '["\\\']|' + escapeRegExp(last) + ')\\s*:', 'g');
  const match = re.exec(text);
  return match ? offsetToPosition(text, match.index) : undefined;
}


export function getInlayHints(text, range, locales, defaultLocale, options = {}) {
  if (options.enabled === false) return [];
  const maxLength = options.maxLength ?? DEFAULT_CONFIG.inlayHints.maxLength;
  const preferred = resolvePreferredLocale(locales, defaultLocale);
  if (!preferred) return [];

  return extractI18nKeys(text)
    .filter((item) => isPositionInRange(item.range.start, range))
    .map((item) => {
      const value = preferred.flat[item.key];
      if (value === undefined) return undefined;
      return {
        position: inlayPositionAfterKeyLiteral(text, item),
        label: truncateInlayText(value, maxLength),
        paddingLeft: true,
        tooltip: value,
      };
    })
    .filter(Boolean);
}

function inlayPositionAfterKeyLiteral(text, item) {
  const next = text[item.endOffset];
  const offset = (next === '"' || next === "'") ? item.endOffset + 1 : item.endOffset;
  return offsetToPosition(text, offset);
}

function isPositionInRange(position, range) {
  if (!range) return true;
  return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) <= 0;
}

function comparePosition(a, b) {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

function truncateInlayText(value, maxLength) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 1)) + '…';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^()|[\]\{}]/g, '\\$&');
}

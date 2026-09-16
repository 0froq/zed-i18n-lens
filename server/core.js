import { parseDocument, DomUtils } from 'htmlparser2';

export const DEFAULT_CONFIG = Object.freeze({
  defaultLocale: 'zh-CN',
  localeDirs: Object.freeze(['src/locales', 'src/i18n', 'locales', 'i18n']),
  inlayHints: Object.freeze({ enabled: true, maxLength: 24 }),
  rawTextDiagnostics: false,
  packages: Object.freeze([]),
});

export const CONFIG_RELATIVE_PATH = '.zed/i18nlensrc.json';

const TRANSLATABLE_ATTRIBUTES = new Set(['title', 'alt', 'placeholder', 'label', 'aria-label']);
const RAW_TEXT_SKIPPED_TAGS = new Set(['script', 'style', 'code', 'pre', 'i18n', 'i18n-t', 'i18nt', 'trans']);

function isExcludedTemplateNode(node) {
  const attrs = node.attribs || {};
  return node.type === 'comment' || RAW_TEXT_SKIPPED_TAGS.has(node.name)
    || attrs.translate?.toLowerCase() === 'no'
    || Object.keys(attrs).some((name) => /^(?:v-t(?:\.|$)|v-pre$|v-html$|v-text$)/.test(name));
}

function isVueHtmlTemplate(node) {
  return node.name === 'template' && !Object.hasOwn(node.attribs || {}, 'src')
    && (!node.attribs?.lang || /^html$/i.test(node.attribs.lang));
}

function templateInterpolations(text, excludedRanges) {
  const ranges = [];
  let cursor = 0;
  while ((cursor = text.indexOf('{{', cursor)) !== -1) {
    const excluded = excludedRanges.find(({ start, end }) => cursor >= start && cursor < end);
    if (excluded) {
      cursor = excluded.end;
      continue;
    }
    const start = cursor;
    cursor += 2;
    let quote;
    let depth = 0;
    for (; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quote) {
        if (char === '\\') cursor++;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (text.startsWith('/*', cursor)) {
        const end = text.indexOf('*/', cursor + 2);
        cursor = end === -1 ? text.length : end + 1;
      } else if (text.startsWith('//', cursor)) {
        const end = text.indexOf('\n', cursor + 2);
        cursor = end === -1 ? text.length : end;
      } else if (char === '{') {
        depth++;
      } else if (char === '}' && depth > 0) {
        depth--;
      } else if (text.startsWith('}}', cursor)) {
        cursor += 2;
        break;
      }
    }
    ranges.push({ start, end: Math.min(cursor, text.length) });
  }
  return ranges;
}

// Intentionally conservative: natural-language candidates, not arbitrary strings
// or a dictionary. Single title-cased labels and non-Latin text are useful too.
export function isLikelyUserFacingText(value) {
  const text = value.trim();
  if (!/\p{L}/u.test(text)) return false;
  if (/^(?:https?:|mailto:|www\.|[/#])|\S+@\S+\.\S+/i.test(text)) return false;
  if (/^[\w.-]+(?:[/\\][\w.-]+)+$|^[\w-]+(?:\.[\w-]+)+$/.test(text)) return false;
  if (/^[A-Z\d_-]+$|^[a-z\d]+(?:[_-][a-z\d]+)+$|^[a-z]+(?:[A-Z][a-z\d]*)+$/.test(text)) return false;
  if (/[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}\p{M}\s]/u.test(text)) return true;
  return (/\s/.test(text) && (text.match(/\p{L}[\p{L}\p{M}]*/gu) || []).length >= 2)
    || /^\p{Lu}\p{Ll}{2,}[.!?…]?$/u.test(text);
}

/**
 * Detect only template text/attributes. Parser indices and JS string offsets are
 * UTF-16, matching LSP positions. Mask Vue expressions before HTML parsing so
 * comparisons and string literals inside {{ ... }} cannot become markup.
 */
export function getRawTextDiagnostics(text, language, enabled = false) {
  if (!enabled || !['vue', 'html'].includes(language)) return [];
  const parserOptions = { withStartIndices: true, withEndIndices: true, recognizeSelfClosing: true };
  // An unmatched "{{" in a comment, script, style or custom SFC block must
  // never mask the template that follows it. Let the HTML parser locate these.
  const excludedRanges = [];
  function excludeNonTemplate(node, topLevel = false) {
    if (isExcludedTemplateNode(node)
      || (language === 'vue' && topLevel && node.name && !isVueHtmlTemplate(node))) {
      excludedRanges.push({ start: node.startIndex, end: node.endIndex + 1 });
      return;
    }
    for (const child of node.children || []) excludeNonTemplate(child);
  }
  for (const node of parseDocument(text, parserOptions).children) excludeNonTemplate(node, true);
  const interpolations = templateInterpolations(text, excludedRanges);
  let previous = 0;
  const masked = interpolations.map(({ start, end }) => {
    const part = text.slice(previous, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ');
    previous = end;
    return part;
  }).join('') + text.slice(previous);
  const document = parseDocument(masked, parserOptions);
  const diagnostics = [];
  function report(raw, start, value = raw) {
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.trimEnd().length;
    if (!isLikelyUserFacingText(value)) return;
    diagnostics.push({
      range: makeRange(text, start + leading, start + trailing),
      severity: 2,
      code: 'raw-text',
      source: 'i18n-lens',
      message: 'Potential untranslated text: ' + JSON.stringify(value.trim()),
    });
  }
  function visit(node) {
    if (node.type === 'text') {
      const raw = text.slice(node.startIndex, node.endIndex + 1);
      // Report each literal part separately, never an interpolation expression.
      let cursor = 0;
      for (const { start, end } of interpolations) {
        if (end <= node.startIndex || start > node.endIndex) continue;
        const part = raw.slice(cursor, Math.max(0, start - node.startIndex));
        report(part, node.startIndex + cursor, DomUtils.textContent(parseDocument(part)));
        cursor = Math.min(raw.length, end - node.startIndex);
      }
      const part = raw.slice(cursor);
      report(part, node.startIndex + cursor, DomUtils.textContent(parseDocument(part)));
      return;
    }
    if (!node.name) return;
    const attrs = node.attribs || {};
    if (isExcludedTemplateNode(node)) return;
    // HTML parser determines element boundaries; this small lexer only recovers
    // exact source spans for attributes (including quoted > characters).
    const opening = /^<[^\s/>]+((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(text.slice(node.startIndex));
    if (opening) {
      const prefixLength = opening[0].length - opening[1].length - 1;
      for (const match of opening[1].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        const name = match[1].toLowerCase();
        const bound = name.startsWith(':') || name.startsWith('v-bind:');
        const target = bound ? name.replace(/^(?::|v-bind:)/, '') : name;
        if (!TRANSLATABLE_ATTRIBUTES.has(target) || !match[0].includes('=')) continue;
        let raw = match[2] ?? match[3] ?? match[4] ?? '';
        if (raw.includes('{{')) continue;
        const valuePrefix = /^[^=]+=\s*["']?/.exec(match[0])[0].length;
        let start = node.startIndex + prefixLength + match.index + valuePrefix;
        let value = attrs[name] ?? raw;
        if (bound) {
          // No JS parsing: only a whole, unescaped quoted string is safe.
          const literal = /^\s*(['"])([^\\\r\n]*?)\1\s*$/.exec(raw);
          const decodedLiteral = /^\s*(['"])([^\\\r\n]*?)\1\s*$/.exec(value);
          if (!literal || literal[2].includes(literal[1])
            || !decodedLiteral || decodedLiteral[2].includes(decodedLiteral[1])) continue;
          start += raw.indexOf(literal[1]) + 1;
          raw = literal[2];
          value = decodedLiteral[2];
        }
        report(raw, start, value);
      }
    }
    for (const child of node.children || []) visit(child);
  }
  if (language === 'vue') {
    for (const node of document.children) {
      if (!isVueHtmlTemplate(node) || isExcludedTemplateNode(node)) continue;
      for (const child of node.children || []) visit(child);
    }
  } else {
    for (const node of document.children) visit(node);
  }
  return diagnostics;
}

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
    rawTextDiagnostics: typeof raw.rawTextDiagnostics === 'boolean' ? raw.rawTextDiagnostics : defaults.rawTextDiagnostics,
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

export function extractI18nKeys(text) {
  const found = [];
  collectFunctionCallKeys(text, found);
  collectFormatMessageKeys(text, found);
  const patterns = [
    // <i18n-t keypath="key"> (Vue I18n) and <Trans i18nKey="key"> (react-i18next)
    /\b(?:keypath|i18nKey)\s*=\s*(['"])([A-Za-z0-9_.:-]+)\1/g,
    /\bv-t\s*=\s*"'([A-Za-z0-9_.:-]+)'"/g,
    /\bv-t\s*=\s*"\s*\{\s*path\s*:\s*(['"])([A-Za-z0-9_.:-]+)\1/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) {
      const key = match[2] || match[1];
      const keyOffsetInMatch = match[0].indexOf(key);
      const start = match.index + keyOffsetInMatch;
      const end = start + key.length;
      found.push({ key, range: makeRange(text, start, end), startOffset: start, endOffset: end });
    }
  }
  found.sort((a, b) => a.startOffset - b.startOffset);
  return found;
}

function collectFunctionCallKeys(text, found) {
  // t/$t/tc/$tc/i18n.t/i18n.tc(...) — function calls, incl. Vue I18n plural tc
  const re = /(?:\x24tc?|\btc?|\bi18n\.tc?)\s*\(/g;
  let match;
  while ((match = re.exec(text))) {
    const parenOffset = re.lastIndex - 1;
    const callText = readParens(text, parenOffset);
    if (!callText) continue;
    const keyMatch = callText.match(/^\(\s*(['"])([A-Za-z0-9_.:-]+)\1/);
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

function collectFormatMessageKeys(text, found) {
  const re = /\bformatMessage\s*\(/g;
  let match;
  while ((match = re.exec(text))) {
    const parenOffset = re.lastIndex - 1;
    const callText = readParens(text, parenOffset);
    if (!callText) continue;
    const args = splitArgsWithOffsets(callText.slice(1, -1));
    const idArg = args[0]?.text || '';
    const keyMatch = idArg.match(/\bid\s*:\s*(['"])([A-Za-z0-9_.:-]+)\1/);
    if (!keyMatch) continue;
    const key = keyMatch[2];
    const start = parenOffset + 1 + idArg.indexOf(key);
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
    const position = /\.json$/i.test(candidate.filePath)
      ? findJsonKeyLocation(text, candidate.lookupKey)
      : findLocaleKeyLocation(text, candidate.lookupKey);
    if (position) return { filePath: candidate.filePath, position };
  }

  const fallback = candidates[0];
  return fallback ? { filePath: fallback.filePath } : undefined;
}

function lookupKeyForLocaleFile(locale, filePath, key) {
  const isNestedLocaleFile = normalizeFsPath(locale.path) !== normalizeFsPath(filePath);
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
  const diagnostics = [];
  for (const key of Object.keys(locale.flat)) {
    const consistency = getLocaleParamConsistency(key, locales);
    if (consistency.consistent) continue;
    const lookupKey = lookupKeyForLocaleFile(locale, filePath, key);
    const position = isJson ? findJsonKeyLocation(text, lookupKey) : findLocaleKeyLocation(text, lookupKey);
    if (!position) continue;
    const leaf = lookupKey.split('.').at(-1);
    const end = { line: position.line, character: position.character + leaf.length + (isJson ? 2 : 0) };
    diagnostics.push(paramInconsistencyDiagnostic(key, { start: position, end }, consistency.perLocale));
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
  let lineFallback;
  let lineFallbackCount = 0;
  for (const fullKey of Object.keys(locale.flat)) {
    const lookupKey = lookupKeyForLocaleFile(locale, filePath, fullKey);
    const loc = isJson ? findJsonKeyLocation(text, lookupKey) : findLocaleKeyLocation(text, lookupKey);
    if (!loc || loc.line !== position.line) continue;
    const leaf = lookupKey.split('.').at(-1);
    const tokenStart = loc.character;
    const tokenEnd = tokenStart + leaf.length + (isJson ? 2 : 0);
    if (position.character >= tokenStart && position.character <= tokenEnd) return fullKey;
    lineFallback = fullKey;
    lineFallbackCount++;
  }
  return lineFallbackCount === 1 ? lineFallback : undefined;
}

export function getCompletionPrefix(text, position) {
  const offset = positionToOffset(text, position);
  const before = text.slice(0, offset);
  const patterns = [
    /(?:\x24tc?|\btc?|\bi18n\.tc?)\(\s*['"]([A-Za-z0-9_.:-]*)$/,
    /\bformatMessage\s*\(\s*\{[^}]*?\bid\s*:\s*['"]([A-Za-z0-9_.:-]*)$/,
    /\b(?:keypath|i18nKey)\s*=\s*['"]([A-Za-z0-9_.:-]*)$/,
    /v-t\s*=\s*"'([A-Za-z0-9_.:-]*)$/,
  ];
  for (const re of patterns) {
    const match = before.match(re);
    if (match) return match[1];
  }
  return '';
}

export function findJsonKeyLocation(jsonText, key) {
  const parts = key.split('.');
  let cursor = 0;
  for (const part of parts) {
    const re = new RegExp('"' + escapeRegExp(part) + '"\\s*:', 'g');
    re.lastIndex = cursor;
    const match = re.exec(jsonText);
    if (!match) return undefined;
    cursor = match.index + match[0].length;
    if (part === parts[parts.length - 1]) return offsetToPosition(jsonText, match.index);
  }
  return undefined;
}

// Surgically insert a dotted `key` into a JSON document, creating intermediate
// objects as needed and preserving the rest of the file's formatting. Returns
// the new text, or undefined if the JSON is unparseable or the key already exists.
export function insertNestedJsonKey(jsonText, key, value = '') {
  let root;
  try { root = JSON.parse(jsonText); } catch { return undefined; }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return undefined;
  if (getValueByKey(root, key) !== undefined) return undefined;

  const parts = key.split('.');
  let node = root;
  let existingDepth = 0;
  for (; existingDepth < parts.length - 1; existingDepth++) {
    const next = node[parts[existingDepth]];
    if (next && typeof next === 'object' && !Array.isArray(next)) node = next;
    else break;
  }

  const span = findJsonObjectSpan(jsonText, parts.slice(0, existingDepth));
  if (!span) return undefined;

  const unit = detectIndentUnit(jsonText);
  const snippet = buildNestedProperty(parts.slice(existingDepth), value, unit.repeat(existingDepth + 1), unit);
  const inner = jsonText.slice(span.openBrace + 1, span.contentEnd).trim();
  if (inner.length === 0) {
    return jsonText.slice(0, span.openBrace + 1) + '\n' + snippet + '\n' + unit.repeat(existingDepth) + jsonText.slice(span.closeBrace);
  }
  const needsComma = jsonText[span.contentEnd - 1] !== ',';
  return jsonText.slice(0, span.contentEnd) + (needsComma ? ',' : '') + '\n' + snippet + jsonText.slice(span.contentEnd);
}

function findJsonObjectSpan(jsonText, pathParts) {
  let searchFrom = 0;
  if (pathParts.length) {
    const pos = findJsonKeyLocation(jsonText, pathParts.join('.'));
    if (!pos) return undefined;
    const colon = jsonText.indexOf(':', positionToOffset(jsonText, pos));
    if (colon === -1) return undefined;
    searchFrom = colon + 1;
  }
  const openBrace = jsonText.indexOf('{', searchFrom);
  if (openBrace === -1) return undefined;
  const closeBrace = matchBrace(jsonText, openBrace);
  if (closeBrace === -1) return undefined;
  let contentEnd = closeBrace;
  while (contentEnd > openBrace + 1 && /\s/.test(jsonText[contentEnd - 1])) contentEnd--;
  return { openBrace, closeBrace, contentEnd };
}

function matchBrace(text, open) {
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

function detectIndentUnit(jsonText) {
  const match = jsonText.match(/\n([ \t]+)\S/);
  return match ? match[1] : '  ';
}

function buildNestedProperty(parts, value, indent, unit) {
  const keyStr = JSON.stringify(parts[0]);
  if (parts.length === 1) return indent + keyStr + ': ' + JSON.stringify(value);
  return indent + keyStr + ': {\n' + buildNestedProperty(parts.slice(1), value, indent + unit, unit) + '\n' + indent + '}';
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

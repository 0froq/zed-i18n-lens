import test from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { flattenLocale, keyAtPosition, localeKeyRangeAtPosition, unquotedRange, validateRenameKey, removeJsonKey, renameJsonKey, planLocaleKeyRename, renameCodeKeyEdits } from '../server/core.js';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const locale = (path, text) => ({ path, files: [path], topLevelFiles: [path], flat: flattenLocale(JSON.parse(text)) });

test('rename from a usage rewrites every call of the key', () => {
  const text = `const a = t('home.title');\nconst b = $t("home.title", { n: 1 });\ni18n.t('other');`;
  assert.equal(keyAtPosition(text, { line: 0, character: 15 }).key, 'home.title');
  const edits = renameCodeKeyEdits(text, 'home.title', 'page.heading');
  assert.equal(edits.length, 2);
  assert.equal(TextDocument.applyEdits(TextDocument.create('file:///a.ts', 'typescript', 0, text), edits),
    `const a = t('page.heading');\nconst b = $t("page.heading", { n: 1 });\ni18n.t('other');`);
});

test('rename from a locale file resolves the key and unquoted range', () => {
  const text = json({ home: { title: 'Home' } });
  const found = localeKeyRangeAtPosition(locale('/l/en.json', text), '/l/en.json', text, { line: 2, character: 6 });
  assert.equal(found.key, 'home.title');
  assert.deepEqual(unquotedRange(text, found.range), { start: { line: 2, character: 5 }, end: { line: 2, character: 10 } });
});

test('nested move prunes empty parents and inserts under the new path', () => {
  const text = json({ a: { b: { c: 'C' } }, keep: 'K' });
  assert.equal(removeJsonKey(text, 'a.b.c'), json({ keep: 'K' }));
  assert.equal(renameJsonKey(text, 'a.b.c', 'x.y'), json({ keep: 'K', x: { y: 'C' } }));
  const sibling = json({ a: { b: 'B', c: 'C' } });
  assert.equal(renameJsonKey(sibling, 'a.b', 'a.d'), json({ a: { c: 'C', d: 'B' } }));
  assert.equal(renameJsonKey(json({ 'a.b': 'flat', z: 1 }), 'a.b', 'a.c'), json({ z: 1, a: { c: 'flat' } }));
});

test('multiple locales and namespace files each get a rename plan', () => {
  const en = json({ title: 'Hi' });
  const zh = json({ title: '你好', other: 'x' });
  const enLocale = { path: '/l/en', directories: ['/l/en'], files: ['/l/en/home.json'], flat: { 'home.title': 'Hi' } };
  const zhLocale = { path: '/l/zh', directories: ['/l/zh'], files: ['/l/zh/home.json'], flat: { 'home.title': '你好', 'home.other': 'x' } };
  const texts = { '/l/en/home.json': en, '/l/zh/home.json': zh };
  assert.deepEqual(planLocaleKeyRename(enLocale, 'home.title', 'home.heading', texts).edits.map((e) => e.newText), [json({ heading: 'Hi' })]);
  assert.deepEqual(planLocaleKeyRename(zhLocale, 'home.title', 'home.heading', texts).edits.map((e) => e.newText), [json({ other: 'x', heading: '你好' })]);
  assert.match(planLocaleKeyRename(enLocale, 'home.title', 'about.title', texts).error, /namespace/);
});

test('TS locale modules rename the last segment in place', () => {
  const text = "export default {\n  home: {\n    title: 'Hi',\n  },\n};\n";
  const ts = { path: '/l/en.ts', files: ['/l/en.ts'], topLevelFiles: ['/l/en.ts'], flat: { 'home.title': 'Hi' } };
  assert.equal(planLocaleKeyRename(ts, 'home.title', 'home.heading', { '/l/en.ts': text }).edits[0].newText, text.replace('title', 'heading'));
  assert.match(planLocaleKeyRename(ts, 'home.title', 'other.title', { '/l/en.ts': text }).error, /last key segment/);
});

test('collisions, invalid and parent/child conflicts are rejected', () => {
  const locales = { en: { flat: { 'a.b': 1, c: 2 } }, zh: { flat: { 'a.b': 1, 'd.e': 3 } } };
  assert.equal(validateRenameKey(locales, 'a.b', 'a.x'), undefined);
  assert.match(validateRenameKey(locales, 'a.b', 'c'), /already exists in locale "en"/);
  assert.match(validateRenameKey(locales, 'a.b', 'd'), /child key "d.e"/);
  assert.match(validateRenameKey(locales, 'a.b', 'c.x'), /conflicts with existing key "c"/);
  assert.match(validateRenameKey(locales, 'a.b', ' '), /empty/);
  assert.match(validateRenameKey(locales, 'a.b', 'a..b'), /Invalid/);
});

test('prepareRename helpers return nothing outside keys', () => {
  assert.equal(keyAtPosition("const x = 'home.title';", { line: 0, character: 14 }), undefined);
  const text = json({ home: { title: 'Home' } });
  assert.equal(localeKeyRangeAtPosition(locale('/l/en.json', text), '/l/en.json', text, { line: 2, character: 14 }), undefined);
});

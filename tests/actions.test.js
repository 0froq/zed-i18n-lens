import test from 'node:test';
import assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getExtractCodeActions, getInlineCodeActions, getRawTextDiagnostics } from '../server/core.js';

function apply(text, edit) {
  return TextDocument.applyEdits(TextDocument.create('file:///x', 'vue', 0, text), [edit]);
}

function extract(text, flat = {}, range) {
  return getExtractCodeActions(text, 'vue', '/src/components/LoginForm.vue', range, getRawTextDiagnostics(text, 'vue', true), flat);
}

test('extract template text and attributes to a file-stem key', () => {
  const text = '<template><p title="Sign in now">Hello world</p></template>';
  const actions = extract(text);
  assert.deepEqual(actions.map((a) => [a.key, a.value]), [['LoginForm.sign_in_now', 'Sign in now'], ['LoginForm.hello_world', 'Hello world']]);
  assert.equal(apply(text, actions[0].edit), `<template><p :title="$t('LoginForm.sign_in_now')">Hello world</p></template>`);
  assert.equal(apply(text, actions[1].edit), `<template><p title="Sign in now">{{ $t('LoginForm.hello_world') }}</p></template>`);
});

test('extract rewrites bound string literal attributes', () => {
  const text = `<template><input :placeholder="'Your name'"></template>`;
  const [action] = extract(text);
  assert.equal(apply(text, action.edit), `<template><input :placeholder="$t('LoginForm.your_name')"></template>`);
});

test('extract reuses an existing key with the same text and avoids collisions', () => {
  const text = '<template><b>Hello world</b></template>';
  assert.equal(extract(text, { 'common.hello': 'Hello world' })[0].key, 'common.hello');
  assert.equal(extract(text, { 'common.hello': 'Hello world' })[0].existing, true);
  assert.equal(extract(text, { 'LoginForm.hello_world': 'Other' })[0].key, 'LoginForm.hello_world_2');
});

test('extract skips interpolation/entities and hashes non-Latin text', () => {
  assert.deepEqual(extract('<template><p>Tom &amp; Jerry</p></template>'), []);
  const parts = extract('<template><p>Hi {{ name }} there friend</p></template>');
  assert.deepEqual(parts.map((a) => a.value), ['there friend']);
  assert.match(extract('<template><p>你好世界</p></template>')[0].key, /^LoginForm\.text_[0-9a-f]+$/);
});

test('extract offers selected raw text even without diagnostics', () => {
  const text = '<template><p>Hello world</p></template>';
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } };
  assert.equal(getExtractCodeActions(text, 'vue', '/a/App.vue', range, [], {})[0].key, 'App.hello_world');
});

const locales = { en: { flat: { greet: 'Say "hi" <now>', it: "it's" } }, zh: { flat: { greet: '你好' } } };
const at = (text, needle) => { const p = { line: 0, character: text.indexOf(needle) + 1 }; return { start: p, end: p }; };

test('inline template interpolation as plain text per locale', () => {
  const text = `<template><p>{{ $t('greet') }}</p></template>`;
  const actions = getInlineCodeActions(text, at(text, '$t'), locales);
  assert.deepEqual(actions.map((a) => a.title), ['Inline i18n key "greet" as en', 'Inline i18n key "greet" as zh']);
  assert.equal(apply(text, actions[0].edit), '<template><p>Say &quot;hi&quot; &lt;now&gt;</p></template>');
  assert.equal(apply(text, actions[1].edit), '<template><p>你好</p></template>');
});

test('inline bound attribute becomes a plain attribute', () => {
  const text = `<template><img :alt="$t('greet')"></template>`;
  const [en] = getInlineCodeActions(text, at(text, 'greet'), locales);
  assert.equal(apply(text, en.edit), '<template><img alt="Say &quot;hi&quot; &lt;now&gt;"></template>');
});

test('inline JS call becomes a quoted string literal', () => {
  const text = "const a = t('it');";
  const actions = getInlineCodeActions(text, at(text, 't('), locales);
  assert.equal(actions.length, 1);
  assert.equal(apply(text, actions[0].edit), "const a = 'it\\'s';");
});

test('inline skips calls with params or outside a call', () => {
  const text = "t('greet', { n: 1 }); x";
  assert.deepEqual(getInlineCodeActions(text, at(text, 'greet'), locales), []);
  assert.deepEqual(getInlineCodeActions(text, { start: { line: 0, character: text.length } }, locales), []);
});

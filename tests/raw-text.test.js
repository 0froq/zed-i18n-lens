import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRawTextDiagnostics,
  isLikelyUserFacingText,
  normalizeI18nLensConfig,
  mergeI18nLensConfig,
  resolveProjectContext,
} from '../server/core.js';

function detected(text, language = 'vue') {
  return getRawTextDiagnostics(text, language, true);
}

function sourceSpans(text, language = 'vue') {
  const offset = ({ line, character }) => text.split('\n').slice(0, line).reduce((sum, part) => sum + part.length + 1, 0) + character;
  return detected(text, language).map(({ range }) => text.slice(offset(range.start), offset(range.end)));
}

test('raw text diagnostics are opt-in and limited to Vue/HTML', () => {
  const text = '<template>Hello world</template>';
  assert.deepEqual(getRawTextDiagnostics(text, 'vue'), []);
  assert.deepEqual(getRawTextDiagnostics(text, 'vue', false), []);
  for (const language of ['javascript', 'typescript', 'tsx', 'json', undefined]) {
    assert.deepEqual(getRawTextDiagnostics(text, language, true), []);
  }
});

test('raw text option merges, validates, and inherits into package contexts', () => {
  assert.equal(normalizeI18nLensConfig().rawTextDiagnostics, false);
  assert.equal(normalizeI18nLensConfig({ rawTextDiagnostics: 'true' }).rawTextDiagnostics, false);
  const merged = mergeI18nLensConfig({ rawTextDiagnostics: true }, { inlayHints: { enabled: false } });
  assert.equal(normalizeI18nLensConfig(merged).rawTextDiagnostics, true);
  assert.equal(normalizeI18nLensConfig(mergeI18nLensConfig(merged, { rawTextDiagnostics: false })).rawTextDiagnostics, false);
  const config = normalizeI18nLensConfig({
    rawTextDiagnostics: true,
    packages: [{ root: 'apps/a' }, { root: 'apps/b', rawTextDiagnostics: false }],
  });
  assert.equal(resolveProjectContext('/repo/apps/a/App.vue', '/repo', config).config.rawTextDiagnostics, true);
  assert.equal(resolveProjectContext('/repo/apps/b/App.vue', '/repo', config).config.rawTextDiagnostics, false);
});

test('detects only Vue template content, excluding custom blocks, script, style and comments', () => {
  const text = `<script setup>const message = 'Script message';</script>
<docs><p>Documentation message</p></docs>
<template><p>Hello world</p><!-- Comment message --><script>Script message</script><style>Style message</style></template>
<style>.x::after { content: 'Style message' }</style>`;
  assert.deepEqual(sourceSpans(text), ['Hello world']);
  assert.deepEqual(sourceSpans('<template lang="pug">Hello world</template>'), []);
  assert.deepEqual(sourceSpans('<template src="./x.html">Hello world</template>'), []);
  assert.deepEqual(sourceSpans('<div>Hello world</div>'), []);
  assert.deepEqual(sourceSpans('<template lang="html"><template v-if="ok">Welcome back</template></template>'), ['Welcome back']);
});

test('HTML fragments and full documents detect static text and allowed attributes', () => {
  const text = '<!doctype html><html><head><title>My application</title></head><body><img alt="Profile photo"><input title="Your name" placeholder="Enter name" aria-label="Full name"><option label="Choose item">Save</option><div class="Ignore class" data-label="Ignore data" id="Ignore id"></div></body></html>';
  assert.deepEqual(sourceSpans(text, 'html'), ['My application', 'Profile photo', 'Your name', 'Enter name', 'Full name', 'Choose item', 'Save']);
});

test('only whole unescaped bound attribute string literals are supported', () => {
  const text = `<template><input :placeholder="'Enter name'" v-bind:title=" 'Helpful title' " :alt="photoAlt" :label="$t('Choose item')" :aria-label="'Hello ' + name"><button @click="alert('Click here')" v-if="'Visible label'">Save</button></template>`;
  assert.deepEqual(sourceSpans(text), ['Enter name', 'Helpful title', 'Save']);
  assert.deepEqual(sourceSpans(`<template><div :title="'It\\'s fine'" :alt="\`Template literal\`" :label="ok ? 'Yes please' : 'No thanks'"/></template>`), []);
  assert.deepEqual(sourceSpans(`<template><div :title="'Hello &apos; + user + &apos; world'"/></template>`), []);
  assert.deepEqual(sourceSpans(`<template><div :title="'Name &amp; surname'"/></template>`), ['Name &amp; surname']);
});

test('interpolations never become text or markup, including quoted delimiters and object literals', () => {
  const text = `<template><p>Hello {{ name }} welcome back</p><p>{{ $t('Hello world') }}</p><p>{{ a < b ? '<b>Fake label</b>' : 'Other label' }}</p><p>{{ "}}" + "Secret label" }}</p><p>{{ { a: { b: 'Secret label' } } }}</p></template>`;
  assert.deepEqual(sourceSpans(text), ['Hello', 'welcome back']);
  assert.deepEqual(sourceSpans('<template><p>{{ unfinished expression'), []);
  assert.deepEqual(sourceSpans('<template><input title="{{ translatedLabel }}"/></template>'), []);
});

test('unmatched interpolation markers in excluded content do not hide following templates', () => {
  const text = `<script>const marker = "{{";</script><docs>{{ example</docs><!-- {{ example --><template><!-- {{ example --><p>Welcome back</p></template>`;
  assert.deepEqual(sourceSpans(text), ['Welcome back']);
  assert.deepEqual(sourceSpans('<script>const marker = "{{";</script><p>Welcome back</p>', 'html'), ['Welcome back']);
  assert.deepEqual(sourceSpans('<template><p>{{ /* }} Fake label */ t("key") }}</p></template>'), []);
  assert.deepEqual(sourceSpans('<template><div v-pre>{{ example</div><p>Welcome back</p></template>'), ['Welcome back']);
  assert.deepEqual(sourceSpans('<template translate="no"><p>Welcome back</p></template>'), []);
});

test('translation components/directives and explicitly excluded subtrees are skipped', () => {
  const text = `<template>
<i18n-t keypath="greeting"><b>Hello world</b></i18n-t>
<I18nT keypath="greeting">Hello world</I18nT>
<Trans i18nKey="greeting">Hello world</Trans>
<i18n path="greeting">Hello world</i18n>
<div v-t="'greeting'" title="Hello world">Hello world</div>
<div v-t.custom="'greeting'">Hello world</div>
<div v-html="html">Hello world</div><div v-text="label">Hello world</div>
<pre>Hello world</pre><code>Hello world</code><div v-pre>Hello world</div>
<div translate="no"><span title="Hello world">Hello world</span></div>
<p>{{ t('greeting') }}</p><button>Save</button></template>`;
  assert.deepEqual(sourceSpans(text), ['Save']);
});

test('heuristics support natural-language scripts and avoid obvious technical tokens', () => {
  for (const value of ['Hello world', 'Save', '立即支付', 'こんにちは', '안녕하세요', 'Привет', 'مرحبا', 'Éditer']) {
    assert.equal(isLikelyUserFacingText(value), true, value);
  }
  for (const value of ['', ' ', '42', '---', '😀', 'API', 'USD', 'save', 'user.name', 'userName', 'user_name', 'user-name', 'https://example.com', 'foo@example.com', '/images/photo.png', 'src/file.js']) {
    assert.equal(isLikelyUserFacingText(value), false, value);
  }
});

test('ranges preserve CRLF, UTF-16, entities and attribute quoting', () => {
  const text = '<template>\r\n  <p>😀 Hello &amp; welcome</p>\r\n  <input title = "  Name &amp; surname  " :placeholder=" \'Enter name\' ">\r\n</template>';
  assert.deepEqual(sourceSpans(text), ['😀 Hello &amp; welcome', 'Name &amp; surname', 'Enter name']);
  const diagnostics = detected(text);
  assert.deepEqual(diagnostics[0].range, { start: { line: 1, character: 5 }, end: { line: 1, character: 27 } });
  assert.equal(diagnostics[0].message, 'Potential untranslated text: "😀 Hello & welcome"');
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.code, 'raw-text');
    assert.equal(diagnostic.severity, 2);
    assert.equal(diagnostic.source, 'i18n-lens');
    assert.equal(diagnostic.data, undefined); // Not eligible for missing-key quick fixes.
  }
});

test('quoted angle brackets, self-closing components, and incomplete HTML remain safe', () => {
  assert.deepEqual(sourceSpans('<template><Widget :visible="a > b" title="Helpful title"/><p>Welcome back</p></template>'), ['Helpful title', 'Welcome back']);
  assert.deepEqual(sourceSpans('<div><input title=Save><p>Hello world', 'html'), ['Save', 'Hello world']);
  assert.deepEqual(sourceSpans('<div title="unfinished attribute', 'html'), []);
});

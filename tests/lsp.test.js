import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';

const serverPath = fileURLToPath(new URL('../server/index.js', import.meta.url));
const position = { line: 0, character: 4 };
const range = { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } };

async function startServer(t, files, settings = {}, workspaceEdit = { documentChanges: true, resourceOperations: ['create'] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-lens-lsp-'));
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  const child = spawn(process.execPath, [serverPath, '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const pending = new Map();
  const diagnostics = new Map();
  const waiters = new Set();
  let serial = 0;
  let buffer = Buffer.alloc(0);
  let stderr = '';
  const send = (message) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
      if (buffer.length < headerEnd + 4 + size) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + size).toString());
      buffer = buffer.subarray(headerEnd + 4 + size);
      if (message.method && message.id !== undefined) {
        send({ id: message.id, result: null });
      } else if (message.id !== undefined) {
        const entry = pending.get(message.id);
        if (!entry) continue;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      } else if (message.method === 'textDocument/publishDiagnostics') {
        diagnostics.set(message.params.uri, message.params.diagnostics);
        for (const check of [...waiters]) check(message.params.uri, message.params.diagnostics);
      }
    }
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}\n${stderr}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  // Kill before removing fixtures, including on a failed assertion or handshake.
  t.after(async () => {
    child.kill();
    await closed;
    for (const entry of pending.values()) clearTimeout(entry.timer);
    await fs.rm(root, { recursive: true, force: true });
  });
  const uri = (name) => pathToFileURL(path.join(root, name)).href;
  const call = (method, name, params = {}) => request(method, { textDocument: { uri: uri(name) }, ...params });
  const sync = (name) => call('textDocument/hover', name, { position });
  function nextDiagnostics(name, predicate = () => true, timeoutMs = 5000) {
    const target = uri(name);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Timed out waiting for diagnostics: ${target}`));
      }, timeoutMs);
      const check = (u, items) => {
        if (u !== target || !predicate(items)) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(items);
      };
      waiters.add(check);
    });
  }
  function languageId(name) {
    if (name.endsWith('.vue')) return 'vue';
    if (/\.html?$/i.test(name)) return 'html';
    return 'typescript';
  }
  async function open(name, text, version = 1) {
    send({ method: 'textDocument/didOpen', params: { textDocument: { uri: uri(name), languageId: languageId(name), version, text } } });
    await sync(name);
  }
  function configure(settings) {
    send({ method: 'workspace/didChangeConfiguration', params: { settings: { 'i18n-lens': settings } } });
  }
  async function change(name, text, version) {
    send({ method: 'textDocument/didChange', params: { textDocument: { uri: uri(name), version }, contentChanges: [{ text }] } });
    await sync(name);
  }
  const actions = (name) => call('textDocument/codeAction', name, { range, context: { diagnostics: diagnostics.get(uri(name)) || [] } });
  await request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: { workspace: { workspaceEdit, inlayHint: { refreshSupport: true } } },
    initializationOptions: { defaultLocale: 'en', ...settings },
  });
  send({ method: 'initialized', params: {} });
  return { root, uri, call, open, change, configure, sync, send, diagnostics, actions, nextDiagnostics };
}

function documentEdits(action) {
  return action.edit.documentChanges.filter((change) => change.textDocument);
}

function applyText(text, change) {
  const document = TextDocument.create(change.textDocument.uri, 'json', change.textDocument.version ?? 0, text);
  return TextDocument.applyEdits(document, change.edits);
}

test('create-key edits preserve unsaved locale contents and bind the current document version', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, { 'locales/en.json': '{"known":"Disk"}', 'src/app.ts': source });
  const unsaved = '{\r\n  "known": "Edited",\r\n  "unsaved": "Keep me"\r\n}\r\n';
  await s.open('locales/en.json', unsaved, 7);
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action, 'missing key has a safe creation action');
  const [change] = documentEdits(action);
  assert.deepEqual(change.textDocument, { uri: s.uri('locales/en.json'), version: 7 });
  const updated = applyText(unsaved, change);
  assert.deepEqual(JSON.parse(updated), { known: 'Edited', unsaved: 'Keep me', missing: '' });
  assert.equal(updated.replace(/\r\n/g, '').includes('\n'), false, 'preserves CRLF');
  assert.notDeepEqual(change.edits[0].range.start, { line: 0, character: 0 }, 'does not replace the whole document');
  await s.change('locales/en.json', updated, 8);
  await s.sync('src/app.ts');
  assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')), []);
});

test('directory creation strips the namespace and preserves index translations', async (t) => {
  const source = "t('common.submit')";
  const files = {
    'locales/en/common.json': '{"known":"Known"}',
    'locales/zh/common.json': '{"known":"已知"}',
    'locales/en/index.json': '{"home":"Home"}',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  };
  const s = await startServer(t, files);
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const edits = documentEdits(action);
  assert.deepEqual(edits.map((edit) => edit.textDocument.uri).sort(), [s.uri('locales/en/common.json'), s.uri('locales/zh/common.json')].sort());
  for (const edit of edits) {
    const original = await fs.readFile(fileURLToPath(edit.textDocument.uri), 'utf8');
    assert.deepEqual(JSON.parse(applyText(original, edit)), { ...JSON.parse(original), submit: '' });
  }
});

test('a missing namespace file is created from an unambiguous sibling-locale layout', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"submit":"Submit"}',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const operations = action.edit.documentChanges;
  assert.equal(operations[0].kind, 'create');
  assert.equal(operations[0].uri, s.uri('locales/zh/common.json'));
  const [edit] = documentEdits(action);
  assert.deepEqual(JSON.parse(applyText('', edit)), { submit: '' });
  assert.equal(edit.textDocument.uri, operations[0].uri);
  assert.equal(edit.textDocument.version, null);
});

test('namespace creation refuses ambiguous JSON and TS targets', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"known":"Known"}',
    'locales/en/common.ts': "export default { other: 'Other' };",
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('missing-file creation requires client resource-operation support', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"submit":"Submit"}',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  }, {}, { documentChanges: true });
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('clients without versioned document-edit support receive no unsafe create action', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, { 'locales/en.json': '{}', 'src/app.ts': source }, {}, {});
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('an empty locale file is seeded instead of silently dropping the fix', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, { 'locales/en.json': '', 'src/app.ts': source });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action, 'missing key in an empty file still offers a fix');
  const [edit] = documentEdits(action);
  assert.deepEqual(JSON.parse(applyText('', edit)), { missing: '' });
});

test('an empty namespace file is seeded instead of creating a duplicate', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"submit":"Submit"}',
    'locales/zh/common.json': '',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  assert.equal(action.edit.documentChanges.every((op) => op.kind !== 'create'), true, 'no CreateFile for an existing file');
  const [edit] = documentEdits(action);
  assert.equal(edit.textDocument.uri, s.uri('locales/zh/common.json'));
  assert.deepEqual(JSON.parse(applyText('', edit)), { submit: '' });
});

test('seeding a whitespace-only file keeps its CRLF style', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, { 'locales/en.json': '\r\n', 'src/app.ts': source });
  await s.open('src/app.ts', source);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const [edit] = documentEdits(action);
  const updated = applyText('\r\n', edit);
  assert.deepEqual(JSON.parse(updated), { missing: '' });
  assert.equal(updated.replace(/\r\n/g, '').includes('\n'), false, 'keeps CRLF');
});

test('a namespace buffer whose file is absent is edited instead of recreated', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"submit":"Submit"}',
    'locales/zh/index.json': '{"home":"首页"}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  const buffer = '{\r\n  "known": "已知"\r\n}\r\n';
  await s.open('locales/zh/common.json', buffer, 3);
  const [action] = await s.actions('src/app.ts');
  assert.ok(action, 'a live buffer for the missing file still offers the fix');
  assert.equal(action.edit.documentChanges.every((op) => op.kind !== 'create'), true, 'edits the buffer instead of creating the file');
  const [edit] = documentEdits(action);
  assert.equal(edit.textDocument.uri, s.uri('locales/zh/common.json'));
  assert.equal(edit.textDocument.version, 3);
  assert.deepEqual(JSON.parse(applyText(buffer, edit)), { known: '已知', submit: '' });
});

test('hover follows unsaved locale changes and reverts to disk on close', async (t) => {
  const source = "t('known')";
  const s = await startServer(t, { 'locales/en.json': '{"known":"Disk"}', 'src/app.ts': source });
  await s.open('src/app.ts', source);
  await s.open('locales/en.json', '{"known":"Opened"}');
  assert.match((await s.sync('src/app.ts')).contents.value, /Opened/);
  await s.change('locales/en.json', '{"known":"Changed"}', 2);
  assert.match((await s.sync('src/app.ts')).contents.value, /Changed/);
  s.send({ method: 'textDocument/didClose', params: { textDocument: { uri: s.uri('locales/en.json') } } });
  assert.match((await s.sync('src/app.ts')).contents.value, /Disk/);
});

test('top-level and directory TS locales support reverse references without source completions', async (t) => {
  const source = "t('known')";
  const module = "export default { known: 'Known' };";
  const s = await startServer(t, { 'locales/en.ts': module, 'locales/zh/index.ts': module, 'src/app.ts': source });
  await s.open('src/app.ts', source);
  assert.match((await s.sync('src/app.ts')).contents.value, /Known/);
  for (const name of ['locales/en.ts', 'locales/zh/index.ts']) {
    await s.open(name, module);
    const references = await s.call('textDocument/references', name, { position: { line: 0, character: module.indexOf('known') + 1 }, context: { includeDeclaration: false } });
    assert.deepEqual(references.map((ref) => ref.uri), [s.uri('src/app.ts')]);
    assert.deepEqual(await s.call('textDocument/completion', name, { position }), []);
    assert.deepEqual(await s.call('textDocument/inlayHint', name, { range }), []);
  }
});

test('references isolate nested package contexts and include new unsaved source documents', async (t) => {
  const source = "t('shared')";
  const s = await startServer(t, {
    'locales/en.json': '{"shared":"Root"}',
    'src/root.ts': source,
    'apps/web/locales/en.json': '{"shared":"Child"}',
    'apps/web/src/child.ts': source,
  }, { packages: [{ root: 'apps/web', localeDirs: ['locales'] }] });
  await s.open('src/root.ts', source);
  await s.open('src/unsaved.ts', source);
  await s.open('apps/web/src/child.ts', source);
  const rootRefs = await s.call('textDocument/references', 'src/root.ts', { position, context: { includeDeclaration: false } });
  assert.deepEqual(rootRefs.map((ref) => ref.uri).sort(), [s.uri('src/root.ts'), s.uri('src/unsaved.ts')].sort());
  const childRefs = await s.call('textDocument/references', 'apps/web/src/child.ts', { position, context: { includeDeclaration: false } });
  assert.deepEqual(childRefs.map((ref) => ref.uri), [s.uri('apps/web/src/child.ts')]);
});

test('comments and dynamic keys produce no diagnostics or references, and completion stays contextual', async (t) => {
  const source = "// t('ghost')\nconst text = \"t('quoted')\";\nt('prefix.' + name);\nt('known');\nconst unrelated = 1;\nt('";
  const s = await startServer(t, { 'locales/en.json': '{"known":"Known"}', 'src/app.ts': source });
  await s.open('src/app.ts', source);
  assert.deepEqual(s.diagnostics.get(s.uri('src/app.ts')), []);
  assert.deepEqual(await s.call('textDocument/completion', 'src/app.ts', { position: { line: 4, character: 20 } }), []);
  const completions = await s.call('textDocument/completion', 'src/app.ts', { position: { line: 5, character: 3 } });
  assert.deepEqual(completions.map((item) => item.label), ['known']);
  const refs = await s.call('textDocument/references', 'src/app.ts', { position: { line: 0, character: 8 }, context: { includeDeclaration: false } });
  assert.equal(refs, null);
});

test('JSON definition and creation target the correct sibling object', async (t) => {
  const locale = '{"a":{"b":{"c":"Inner"}},"b":{"c":"Outer"}}';
  const source = "t('b.c'); t('b.d')";
  const s = await startServer(t, { 'locales/en.json': locale, 'src/app.ts': source });
  await s.open('src/app.ts', source);
  const locations = await s.call('textDocument/definition', 'src/app.ts', { position });
  assert.equal(locations[0].range.start.character, locale.lastIndexOf('"c"'));
  const [action] = await s.actions('src/app.ts');
  assert.ok(action);
  const [edit] = documentEdits(action);
  assert.deepEqual(JSON.parse(applyText(locale, edit)), { a: { b: { c: 'Inner' } }, b: { c: 'Outer', d: '' } });
});

test('TS locale diagnostics validate translations rather than treating the file as source', async (t) => {
  const en = "export default { greeting: 'Hi {name}' };";
  const zh = "export default { greeting: '你好' };";
  const s = await startServer(t, { 'locales/en.ts': en, 'locales/zh.ts': zh });
  await s.open('locales/en.ts', en);
  const diagnostics = s.diagnostics.get(s.uri('locales/en.ts'));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].data.key, 'greeting');
  assert.deepEqual(diagnostics[0].data.paramInconsistency.map((entry) => ({ name: entry.name, params: entry.params })), [
    { name: 'en', params: ['name'] },
    { name: 'zh', params: [] },
  ]);
  await s.open('locales/zh.ts', "export default { greeting: '你好 {name}' };");
  await s.sync('locales/en.ts');
  assert.deepEqual(s.diagnostics.get(s.uri('locales/en.ts')), []);
});

test('namespace creation refuses an empty index-owned namespace', async (t) => {
  const source = "t('common.submit')";
  const s = await startServer(t, {
    'locales/en/common.json': '{"known":"Known"}',
    'locales/en/index.json': '{"common":{}}',
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('creation never repairs only the writable half of a multi-locale diagnostic', async (t) => {
  const source = "t('missing')";
  const s = await startServer(t, {
    'locales/en.json': '{}',
    'locales/zh.ts': "export default { known: '已知' };",
    'src/app.ts': source,
  });
  await s.open('src/app.ts', source);
  assert.deepEqual(await s.actions('src/app.ts'), []);
});

test('stdio LSP publishes opt-in template diagnostics and clears them on settings/content changes', { timeout: 15000 }, async (t) => {
  // No locale files: raw text diagnostics must not depend on locale discovery.
  const s = await startServer(t, {});

  let pending = s.nextDiagnostics('RawText.vue');
  await s.open('RawText.vue', '<template><button>Save changes</button></template>');
  assert.deepEqual(await pending, []);

  pending = s.nextDiagnostics('RawText.vue', (items) => items.some((item) => item.code === 'raw-text'));
  s.configure({ rawTextDiagnostics: true });
  assert.equal((await pending).length, 1);

  pending = s.nextDiagnostics('RawText.html');
  await s.open('RawText.html', '<input placeholder="Enter name">');
  assert.equal((await pending)[0].code, 'raw-text');

  pending = s.nextDiagnostics('RawText.js');
  await s.open('RawText.js', 'const label = "Save changes";');
  assert.deepEqual(await pending, []);

  pending = s.nextDiagnostics('RawText.vue');
  await s.change('RawText.vue', '<template><button>{{ t("save") }}</button></template>', 2);
  assert.deepEqual(await pending, []);

  pending = s.nextDiagnostics('RawText.html', (items) => items.length === 0);
  s.configure({ rawTextDiagnostics: false });
  assert.deepEqual(await pending, []);
});

test('extract action writes the default locale and rewrites the template', async (t) => {
  const s = await startServer(t, { 'locales/en.json': '{\n  "known": "Known"\n}\n' }, { rawTextDiagnostics: true });
  const source = '<template><p>Hello world</p><b>{{ $t(\'known\') }}</b></template>';
  const pending = s.nextDiagnostics('src/Home.vue', (items) => items.some((item) => item.code === 'raw-text'));
  await s.open('src/Home.vue', source);
  await pending;
  const all = await s.actions('src/Home.vue');
  const action = all.find((a) => a.title.startsWith('Extract'));
  assert.equal(action.title, 'Extract to i18n key "Home.hello_world"');
  const [locale, doc] = documentEdits(action);
  assert.equal(applyText('{\n  "known": "Known"\n}\n', locale), '{\n  "known": "Known",\n  "Home": {\n    "hello_world": "Hello world"\n  }\n}\n');
  assert.equal(applyText(source, doc), '<template><p>{{ $t(\'Home.hello_world\') }}</p><b>{{ $t(\'known\') }}</b></template>');
  const inline = await s.call('textDocument/codeAction', 'src/Home.vue', { range: { start: { line: 0, character: 38 }, end: { line: 0, character: 38 } }, context: { diagnostics: [] } });
  assert.deepEqual(inline.map((a) => a.title), ['Inline i18n key "known" as en']);
  assert.equal(applyText(source, documentEdits(inline[0])[0]), '<template><p>Hello world</p><b>Known</b></template>');
});

test('rename updates all locales and unopened source usages in one WorkspaceEdit', async (t) => {
  const en = '{\n  "home": {\n    "title": "Home"\n  },\n  "x": "X"\n}\n';
  const zh = '{\n  "home": {\n    "title": "主页"\n  }\n}\n';
  const s = await startServer(t, { 'locales/en.json': en, 'locales/zh.json': zh, 'src/Other.ts': "t('home.title');\n" });
  const source = "<template>{{ $t('home.title') }}</template>";
  await s.open('src/App.vue', source);
  const position = { line: 0, character: 20 };
  assert.deepEqual(await s.call('textDocument/prepareRename', 'src/App.vue', { position }),
    { range: { start: { line: 0, character: 17 }, end: { line: 0, character: 27 } }, placeholder: 'home.title' });
  assert.equal(await s.call('textDocument/prepareRename', 'src/App.vue', { position: { line: 0, character: 2 } }), null);
  const edit = await s.call('textDocument/rename', 'src/App.vue', { position, newName: 'page.heading' });
  const byFile = Object.fromEntries(edit.documentChanges.map((c) => [path.relative(s.root, fileURLToPath(c.textDocument.uri)), c]));
  assert.equal(applyText(en, byFile['locales/en.json']), '{\n  "x": "X",\n  "page": {\n    "heading": "Home"\n  }\n}\n');
  assert.equal(applyText(zh, byFile['locales/zh.json']), '{\n  "page": {\n    "heading": "主页"\n  }\n}\n');
  assert.equal(applyText(source, byFile['src/App.vue']), "<template>{{ $t('page.heading') }}</template>");
  assert.equal(applyText("t('home.title');\n", byFile['src/Other.ts']), "t('page.heading');\n");
  const fromLocale = await s.call('textDocument/prepareRename', 'locales/en.json', { position: { line: 2, character: 6 } });
  assert.equal(fromLocale.placeholder, 'home.title');
  await assert.rejects(s.call('textDocument/rename', 'src/App.vue', { position, newName: 'x' }), /already exists/);
});

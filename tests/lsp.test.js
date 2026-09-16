import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver/node.js';

test('stdio LSP publishes opt-in template diagnostics and clears them on settings/content changes', { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url)), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  t.after(() => {
    connection.dispose();
    child.kill();
  });
  connection.onRequest('workspace/inlayHint/refresh', () => null);
  connection.listen();
  function nextDiagnostics(uri, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.dispose();
        reject(new Error('Timed out waiting for diagnostics: ' + uri));
      }, 5000);
      const subscription = connection.onNotification('textDocument/publishDiagnostics', (params) => {
        if (params.uri !== uri || !predicate(params.diagnostics)) return;
        clearTimeout(timer);
        subscription.dispose();
        resolve(params.diagnostics);
      });
    });
  }
  // No locale files: raw text diagnostics must not depend on locale discovery.
  const rootUri = new URL('./', import.meta.url).href;
  const vueUri = new URL('./RawText.vue', import.meta.url).href;
  const htmlUri = new URL('./RawText.html', import.meta.url).href;
  const jsUri = new URL('./RawText.js', import.meta.url).href;
  await connection.sendRequest('initialize', { processId: process.pid, rootUri, capabilities: {} });
  connection.sendNotification('initialized', {});
  let pending = nextDiagnostics(vueUri);
  connection.sendNotification('textDocument/didOpen', { textDocument: { uri: vueUri, languageId: 'vue', version: 1, text: '<template><button>Save changes</button></template>' } });
  assert.deepEqual(await pending, []);

  pending = nextDiagnostics(vueUri, (items) => items.some((item) => item.code === 'raw-text'));
  connection.sendNotification('workspace/didChangeConfiguration', { settings: { 'i18n-lens': { rawTextDiagnostics: true } } });
  assert.equal((await pending).length, 1);

  pending = nextDiagnostics(htmlUri);
  connection.sendNotification('textDocument/didOpen', { textDocument: { uri: htmlUri, languageId: 'html', version: 1, text: '<input placeholder="Enter name">' } });
  assert.equal((await pending)[0].code, 'raw-text');

  pending = nextDiagnostics(jsUri);
  connection.sendNotification('textDocument/didOpen', { textDocument: { uri: jsUri, languageId: 'javascript', version: 1, text: 'const label = "Save changes";' } });
  assert.deepEqual(await pending, []);

  pending = nextDiagnostics(vueUri);
  connection.sendNotification('textDocument/didChange', { textDocument: { uri: vueUri, version: 2 }, contentChanges: [{ text: '<template><button>{{ t("save") }}</button></template>' }] });
  assert.deepEqual(await pending, []);

  pending = nextDiagnostics(htmlUri, (items) => items.length === 0);
  connection.sendNotification('workspace/didChangeConfiguration', { settings: { 'i18n-lens': { rawTextDiagnostics: false } } });
  assert.deepEqual(await pending, []);
  await connection.sendRequest('shutdown');
  connection.sendNotification('exit');
});

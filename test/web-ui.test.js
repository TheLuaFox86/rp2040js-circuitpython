const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const vm = require('node:vm');
const { startWebUI } = require('../src/web-ui');

test('web UI serves its page and queues keyboard input', async (t) => {
  const keys = [];
  const web = startWebUI({
    host: '127.0.0.1',
    port: 0,
    tftEnabled: true,
    cardkbEnabled: true,
    onKey: (key) => keys.push(key),
    getFrame: () => ({ width: 1, height: 1, pixels: 'AAA=' }),
  });
  t.after(() => web.close());
  await once(web.server, 'listening');
  const baseUrl = `http://127.0.0.1:${web.server.address().port}`;

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /ST7789 TFT/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));

  const response = await fetch(`${baseUrl}/keyboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'x' }),
  });
  assert.equal(response.status, 204);
  assert.deepEqual(keys, ['x']);

  const invalid = await fetch(`${baseUrl}/keyboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: '💡' }),
  });
  assert.equal(invalid.status, 400);

  const stream = await fetch(`${baseUrl}/events`);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel());
  const decoder = new TextDecoder();
  async function readUntil(marker) {
    let text = '';
    while (!text.includes(marker)) {
      let timeout;
      const read = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('SSE event timed out')), 1000);
        }),
      ]).finally(() => clearTimeout(timeout));
      const { value, done } = read;
      if (done) break;
      text += decoder.decode(value);
    }
    return text;
  }
  assert.match(await readUntil('event: status'), /"cardkb":true/);
  web.publishFrame({ width: 1, height: 1, pixels: 'AQI=' });
  assert.match(await readUntil('AQI='), /event: frame/);
});

test('web UI rejects keyboard input while CardKB is disabled', async (t) => {
  const web = startWebUI({
    host: '127.0.0.1',
    port: 0,
    tftEnabled: false,
    cardkbEnabled: false,
    onKey() {},
    getFrame: () => null,
  });
  t.after(() => web.close());
  await once(web.server, 'listening');
  const response = await fetch(`http://127.0.0.1:${web.server.address().port}/keyboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'x' }),
  });
  assert.equal(response.status, 409);
});

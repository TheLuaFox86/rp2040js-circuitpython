const http = require('node:http');

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RP2040 CircuitPython Simulator</title>
  <style>
    :root { color-scheme: dark; font: 16px system-ui, sans-serif; background: #10151c; color: #e8eef5; }
    body { max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; }
    section { margin: 1.5rem 0; padding: 1rem; border: 1px solid #344252; border-radius: 8px; }
    canvas { display: block; width: min(100%, 480px); height: auto; image-rendering: pixelated; background: #000; }
    input { width: min(100%, 24rem); padding: .6rem; font: inherit; }
    .status { color: #a9bacb; }
  </style>
</head>
<body>
  <h1>RP2040 CircuitPython Simulator</h1>
  <p class="status" id="status">Connecting to simulator…</p>
  <section id="display-section" hidden>
    <h2>ST7789 TFT</h2>
    <canvas id="display"></canvas>
  </section>
  <section id="keyboard-section" hidden>
    <h2>M5Stack CardKB</h2>
    <p>Click the field, then type. Keystrokes are sent to the emulated I2C keyboard.</p>
    <input id="keyboard" autocomplete="off" spellcheck="false" aria-label="CardKB input">
  </section>
  <script>
    const status = document.querySelector('#status');
    const displaySection = document.querySelector('#display-section');
    const keyboardSection = document.querySelector('#keyboard-section');
    const canvas = document.querySelector('#display');
    const context = canvas.getContext('2d');
    const events = new EventSource('/events');
    events.addEventListener('status', (event) => {
      const state = JSON.parse(event.data);
      displaySection.hidden = !state.tft;
      keyboardSection.hidden = !state.cardkb;
      status.textContent = state.tft || state.cardkb
        ? 'Optional devices are connected to the simulator.'
        : 'Enable tft.enabled and/or cardkb.enabled in BOARD_CONFIG to use the optional devices.';
    });
    events.addEventListener('frame', (event) => {
      const frame = JSON.parse(event.data);
      canvas.width = frame.width;
      canvas.height = frame.height;
      const bytes = Uint8Array.from(atob(frame.pixels), (character) => character.charCodeAt(0));
      const image = context.createImageData(frame.width, frame.height);
      for (let index = 0; index < frame.width * frame.height; index++) {
        const pixel = bytes[index * 2] | (bytes[index * 2 + 1] << 8);
        const offset = index * 4;
        image.data[offset] = ((pixel >> 11) & 0x1f) * 255 / 31;
        image.data[offset + 1] = ((pixel >> 5) & 0x3f) * 255 / 63;
        image.data[offset + 2] = (pixel & 0x1f) * 255 / 31;
        image.data[offset + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    });
    events.onopen = () => { status.dataset.connected = 'true'; };
    events.onerror = () => { status.dataset.connected = 'false'; };
    const keyboard = document.querySelector('#keyboard');
    keyboard.addEventListener('keydown', async (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 &&
        !['Enter', 'Backspace', 'Tab', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      const key = { Enter: '\\r', Backspace: '\\b', Tab: '\\t', Escape: '\\x1b' }[event.key] || event.key;
      const response = await fetch('/keyboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!response.ok) status.textContent = 'Could not send key to CardKB.';
    });
  </script>
</body>
</html>`;

function startWebUI({ host, port, tftEnabled, cardkbEnabled, onKey, getFrame }) {
  const clients = new Set();
  let latestFrame = null;
  let closeRequested = false;

  function sendEvent(response, name, data) {
    response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.write('retry: 1000\n\n');
      clients.add(response);
      sendEvent(response, 'status', { tft: tftEnabled, cardkb: cardkbEnabled });
      const frame = getFrame();
      if (frame) sendEvent(response, 'frame', frame);
      response.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/keyboard') {
      if (!cardkbEnabled) {
        response.writeHead(409);
        response.end('CardKB is disabled');
        return;
      }
      let body = '';
      let tooLarge = false;
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        if (tooLarge) return;
        body += chunk;
        if (body.length > 128) {
          tooLarge = true;
          body = '';
        }
      });
      request.on('end', () => {
        if (tooLarge) {
          response.writeHead(413);
          response.end('Request body too large');
          return;
        }
        try {
          const value = JSON.parse(body);
          if (typeof value.key !== 'string' || value.key.length !== 1 ||
            value.key.charCodeAt(0) > 0xff) {
            response.writeHead(400);
            response.end('Expected a single-byte key');
            return;
          }
          onKey(value.key);
          response.writeHead(204);
          response.end();
        } catch (error) {
          if (error instanceof SyntaxError) {
            response.writeHead(400);
            response.end('Invalid JSON');
            return;
          }
          if (error instanceof RangeError) {
            response.writeHead(429);
            response.end('CardKB key buffer is full');
            return;
          }
          response.writeHead(500);
          response.end('Unable to queue key');
          console.error(`Web UI keyboard error: ${error.message}`);
        }
      });
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });

  server.on('error', (error) => {
    console.error(`Web UI server error: ${error.message}`);
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.error(`Simulator web UI: http://${host}:${address.port}`);
    if (closeRequested) server.close();
  });

  return {
    publishFrame(frame) {
      latestFrame = frame;
      for (const client of clients) sendEvent(client, 'frame', frame);
    },
    getFrame() {
      return latestFrame;
    },
    close() {
      closeRequested = true;
      for (const client of clients) client.end();
      clients.clear();
      if (server.listening) server.close();
    },
    server,
  };
}

module.exports = { startWebUI };

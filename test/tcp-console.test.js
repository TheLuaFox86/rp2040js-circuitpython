const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { startTcpConsole } = require('../src/tcp-console');

test('new Telnet client receives all output buffered before connecting', async (t) => {
  const consoleServer = startTcpConsole({
    host: '127.0.0.1',
    port: 0,
    onSerialBytes() {},
  });
  t.after(() => consoleServer.close());
  await new Promise((resolve) => consoleServer.server.once('listening', resolve));

  const oldOutput = Buffer.alloc(256 * 1024, 0x78);
  consoleServer.write(oldOutput);

  const socket = net.createConnection(consoleServer.server.address().port, '127.0.0.1');
  t.after(() => socket.destroy());

  const received = [];
  let receivedLength = 0;
  socket.on('data', (chunk) => {
    received.push(chunk);
    receivedLength += chunk.length;
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for buffered output')), 2000);
    const check = () => {
      const outputBytes = Buffer.concat(received, receivedLength);
      let matched = 0;
      for (const byte of outputBytes) {
        if (byte === 0x78) matched++;
      }
      if (matched === oldOutput.length) {
        clearTimeout(timeout);
        resolve();
      }
    };
    socket.on('data', check);
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  const outputBytes = Buffer.concat(received, receivedLength);
  let matched = 0;
  for (const byte of outputBytes) {
    if (byte === 0x78) matched++;
  }
  assert.equal(matched, oldOutput.length);
});

test('Telnet console sends a trailing carriage return without waiting for more output', async (t) => {
  const consoleServer = startTcpConsole({
    host: '127.0.0.1',
    port: 0,
    onSerialBytes() {},
  });
  t.after(() => consoleServer.close());
  await new Promise((resolve) => consoleServer.server.once('listening', resolve));

  const socket = net.createConnection(consoleServer.server.address().port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const received = [];
  socket.on('data', (chunk) => received.push(chunk));
  consoleServer.write(Buffer.from('ready\r'));

  const output = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for serial output')), 2000);
    const check = () => {
      const bytes = Buffer.concat(received);
      if (bytes.includes(Buffer.from([0x72, 0x65, 0x61, 0x64, 0x79, 0x0d, 0x00]))) {
        clearTimeout(timeout);
        resolve(bytes);
      }
    };
    socket.on('data', check);
    check();
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  assert.ok(output.includes(Buffer.from([0x72, 0x65, 0x61, 0x64, 0x79, 0x0d, 0x00])));
});

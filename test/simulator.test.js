const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');
const { BOARD_CONFIG, createSimulator } = require('../src');

function makeImage(directory, name) {
  const image = path.join(directory, name);
  const fd = fs.openSync(image, 'w');
  fs.ftruncateSync(fd, 1024 * 1024);
  fs.closeSync(fd);
  return image;
}

test('firmware runs before a Telnet client connects', async (t) => {
  const simulator = createSimulator({
    ...BOARD_CONFIG,
    serial: { host: '127.0.0.1', port: 0 },
    gdbPort: 0,
    web: { enabled: false },
    spi: { ...BOARD_CONFIG.spi, cards: [] },
  });
  t.after(() => simulator.stop());

  simulator.start();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(simulator.rp2040.cycles > 0);
  assert.notEqual(simulator.rp2040.PC, BOARD_CONFIG.firmwareEntryPoint);
  assert.ok(simulator.servers.serial.listening);
});

test('optional display and CardKB are exposed through the local web UI', async (t) => {
  const simulator = createSimulator({
    ...BOARD_CONFIG,
    serial: { host: '127.0.0.1', port: 0 },
    gdbPort: 0,
    web: { enabled: true, host: '127.0.0.1', port: 0 },
    tft: { ...BOARD_CONFIG.tft, enabled: true },
    cardkb: { ...BOARD_CONFIG.cardkb, enabled: true },
    spi: { ...BOARD_CONFIG.spi, cards: [] },
  });
  t.after(() => simulator.stop());

  assert.ok(simulator.tft);
  assert.ok(simulator.cardkb);
  assert.equal(simulator.gpio.read(4).input, true);
  assert.equal(simulator.gpio.read(5).input, true);
  simulator.start();
  await once(simulator.servers.web, 'listening');
  const baseUrl = `http://127.0.0.1:${simulator.servers.web.address().port}`;
  const response = await fetch(`${baseUrl}/keyboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'z' }),
  });

  assert.equal(response.status, 204);
  assert.deepEqual(simulator.cardkb.keys, ['z'.charCodeAt(0)]);
});

test('Python script output is delivered without keyboard input', async (t) => {
  const simulator = createSimulator({
    ...BOARD_CONFIG,
    serial: { host: '127.0.0.1', port: 0 },
    gdbPort: 0,
    web: { enabled: false },
    spi: { ...BOARD_CONFIG.spi, cards: [] },
  });
  t.after(() => simulator.stop());

  let output = '';
  const originalOnSerialData = simulator.cdc.onSerialData;
  const outputReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for Python script output')), 10000);
    simulator.cdc.onSerialData = (data) => {
      if (data instanceof Uint8Array) output += Buffer.from(data).toString('utf8');
      originalOnSerialData(data);
      if (output.includes('WHAT IS YOUR NAME?')) {
        clearTimeout(timeout);
        resolve();
      }
    };
  });

  simulator.start();
  await new Promise((resolve) => simulator.servers.serial.once('listening', resolve));
  const socket = net.createConnection(simulator.servers.serial.address().port, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.on('data', () => {});

  await outputReady;
  assert.match(output, /BOOT START[\s\S]*ABOUT TO ASK[\s\S]*WHAT IS YOUR NAME\?/);
});

test('multiple SD images share one SPI bus with separate GPIO chip selects', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rp2040js-sd-bus-'));
  const firstImage = makeImage(directory, 'first.img');
  const secondImage = makeImage(directory, 'second.img');
  t.after(() => {
    fs.unlinkSync(firstImage);
    fs.unlinkSync(secondImage);
    fs.rmdirSync(directory);
  });

  const simulator = createSimulator({
    ...BOARD_CONFIG,
    spi: {
      ...BOARD_CONFIG.spi,
      cards: [
        { image: firstImage, chipSelect: 17 },
        { image: secondImage, chipSelect: 20 },
      ],
    },
    web: { enabled: false },
  });
  t.after(() => simulator.stop());

  const { rp2040 } = simulator;
  const spi = 0x4003c000;
  const sio = 0xd0000000;
  const firstPin = 1 << 17;
  const secondPin = 1 << 20;
  for (const pin of [17, 20]) {
    rp2040.writeUint32(0x40014000 + pin * 8 + 4, 5);
  }
  rp2040.writeUint32(sio + 0x14, firstPin | secondPin);
  rp2040.writeUint32(sio + 0x24, firstPin | secondPin);
  rp2040.writeUint32(sio + 0x18, firstPin);
  rp2040.writeUint32(spi + 0x08, 1);

  function sendResetCommand() {
    for (const byte of [0x40, 0, 0, 0, 0, 0x95]) {
      rp2040.writeUint32(spi + 0x60, byte);
      rp2040.readUint32(spi + 0x60);
    }
    rp2040.writeUint32(spi + 0x60, 0xff);
    return rp2040.readUint32(spi + 0x60);
  }

  assert.equal(sendResetCommand(), 1);
  rp2040.writeUint32(sio + 0x14, firstPin);
  rp2040.writeUint32(sio + 0x18, secondPin);
  assert.equal(sendResetCommand(), 1);
});

test('MCU reset preserves external flash contents', (t) => {
  const simulator = createSimulator({
    ...BOARD_CONFIG,
    serial: { host: '127.0.0.1', port: 0 },
    gdbPort: 0,
    web: { enabled: false },
    spi: { ...BOARD_CONFIG.spi, cards: [] },
  });
  t.after(() => simulator.stop());

  const address = simulator.rp2040.flash.length - 1;
  simulator.rp2040.flash[address] = 0x5a;
  simulator.rp2040.reset();

  assert.equal(simulator.rp2040.flash[address], 0x5a);
  assert.equal(simulator.rp2040.PC, BOARD_CONFIG.firmwareEntryPoint);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { RP2040 } = require('rp2040js');
const { ST7789 } = require('../src/st7789');

test('ST7789 captures RGB565 pixels inside configured address windows', () => {
  const rp2040 = new RP2040();
  const frames = [];
  const display = new ST7789(rp2040, {
    width: 2,
    height: 1,
    pins: { chipSelect: 13, dataCommand: 14, reset: 15 },
  }, (frame) => frames.push(frame));

  display.writeCommand(0x2a);
  for (const byte of [0, 0, 0, 1]) display.writeData(byte);
  display.writeCommand(0x2b);
  for (const byte of [0, 0, 0, 0]) display.writeData(byte);
  display.writeCommand(0x2c);
  for (const byte of [0xf8, 0x00, 0x07, 0xe0]) display.writeData(byte);
  display.flushFrame();

  assert.equal(frames.length, 2);
  const frame = frames.at(-1);
  assert.equal(frame.width, 2);
  assert.equal(frame.height, 1);
  assert.deepEqual(Buffer.from(frame.pixels, 'base64'), Buffer.from([0x00, 0xf8, 0xe0, 0x07]));
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { RP2040 } = require('rp2040js');
const { CARDKB_ADDRESS, CardKB } = require('../src/cardkb');

test('CardKB returns browser-injected ASCII bytes through I2C reads', () => {
  const rp2040 = new RP2040();
  const cardkb = new CardKB(rp2040.i2c[0]);
  const i2c = 0x40044000;
  cardkb.pressKey('A');
  cardkb.pressKey('\r');
  rp2040.writeUint32(i2c + 0x04, CARDKB_ADDRESS);
  rp2040.writeUint32(i2c + 0x6c, 1);

  rp2040.writeUint32(i2c + 0x10, 0x300);
  assert.equal(rp2040.readUint32(i2c + 0x10) & 0xff, 'A'.charCodeAt(0));
  rp2040.writeUint32(i2c + 0x10, 0x300);
  assert.equal(rp2040.readUint32(i2c + 0x10) & 0xff, 13);
  rp2040.writeUint32(i2c + 0x10, 0x300);
  assert.equal(rp2040.readUint32(i2c + 0x10) & 0xff, 0);
});

test('CardKB accepts only single-byte characters', () => {
  const cardkb = new CardKB(new RP2040().i2c[0]);
  assert.throws(() => cardkb.pressKey(''), TypeError);
  assert.throws(() => cardkb.pressKey('ab'), TypeError);
  assert.throws(() => cardkb.pressKey('💡'), RangeError);
});

test('CardKB limits queued input', () => {
  const cardkb = new CardKB(new RP2040().i2c[0]);
  for (let index = 0; index < 256; index++) cardkb.pressKey('x');
  assert.throws(() => cardkb.pressKey('x'), /buffer is full/);
});

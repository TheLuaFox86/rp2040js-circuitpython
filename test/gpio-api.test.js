const assert = require('node:assert/strict');
const test = require('node:test');
const { RP2040 } = require('rp2040js');
const { createGPIOApi } = require('../src/gpio-api');

test('GPIO API drives external inputs and notifies listeners', () => {
  const rp2040 = new RP2040();
  const changes = [];
  const gpio = createGPIOApi(rp2040, (...change) => changes.push(change));
  const pinChanges = [];
  gpio.onChange(2, (...change) => pinChanges.push(change));

  gpio.setInput(2, true);

  assert.equal(gpio.read(2).input, true);
  assert.deepEqual(pinChanges, [[4, 4, true, false]]);
  assert.deepEqual(changes[0], [2, 4, 4, true, false]);
});

test('GPIO API rejects invalid pin numbers and values', () => {
  const gpio = createGPIOApi(new RP2040());
  assert.throws(() => gpio.read(30), RangeError);
  assert.throws(() => gpio.setInput(0, 1), TypeError);
});

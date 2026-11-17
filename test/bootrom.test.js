const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { RP2040 } = require('rp2040js');
const { bootromB1 } = require('../src/bootrom');

test('boot ROM binary is loaded as little-endian words at the correct byte offset', () => {
  const image = fs.readFileSync(path.join(__dirname, '..', 'firmware', 'bootrom.bin'));

  assert.ok(bootromB1 instanceof Uint32Array);
  assert.equal(bootromB1.length, 4096);
  assert.equal(bootromB1[0], image.readUInt32LE(0));
  assert.equal(bootromB1[1], image.readUInt32LE(4));
  assert.equal(bootromB1[0], 0x20041f00);
  assert.equal(bootromB1[1], 0x000000ef);

  const rp2040 = new RP2040();
  rp2040.loadBootrom(bootromB1);
  assert.equal(rp2040.SP, bootromB1[0]);
  assert.equal(rp2040.PC, bootromB1[1] & 0xfffffffe);
});

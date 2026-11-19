const assert = require('node:assert/strict');
const test = require('node:test');
const { RP2040 } = require('rp2040js');
const { SPIPeripheral } = require('../src/spi0');

test('SPI peripheral routes bytes to every selected card and combines responses', () => {
  const received = [];
  const cards = [
    { selected: true, transfer(byte) { received.push(byte); return 0xf0; } },
    { selected: true, transfer(byte) { received.push(byte); return 0x0f; } },
  ];
  const rp2040 = { gpio: [{ setInputValue() {}, checkForUpdates() {} }] };
  const spi = new SPIPeripheral(rp2040, cards, 0);
  spi.writeUint32(0x04, 0x2);
  spi.writeUint32(0x08, 0xa5);

  assert.deepEqual(received, [0xa5, 0xa5]);
  assert.equal(spi.readUint32(0x08), 0);
  assert.equal(spi.readUint32(0x0c) & 0x4, 0);
});

test('SPI peripheral returns idle-high data when no card is selected', () => {
  const spi = new SPIPeripheral({ gpio: [] }, [{ selected: false }]);
  spi.writeUint32(0x04, 0x2);
  spi.writeUint32(0x08, 0x00);

  assert.equal(spi.readUint32(0x08), 0xff);
});

test('RP2040 SPI0 memory-mapped registers reach the SD bus', () => {
  const rp2040 = new RP2040();
  const card = { selected: true, transfer: () => 0x7e };
  rp2040.peripherals[0x4003c] = new SPIPeripheral(rp2040, [card]);
  rp2040.writeUint32(0x4003c004, 0x2);
  rp2040.writeUint32(0x4003c008, 0x12);

  assert.equal(rp2040.readUint32(0x4003c008), 0x7e);
});

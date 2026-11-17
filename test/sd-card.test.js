const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SDCardImage } = require('../src/sd-card');

function command(card, number, argument = 0, crc = number === 0 ? 0x95 : number === 8 ? 0x87 : 0xff) {
  const packet = [
    0x40 | number,
    (argument >>> 24) & 0xff,
    (argument >>> 16) & 0xff,
    (argument >>> 8) & 0xff,
    argument & 0xff,
    crc,
  ];
  for (const byte of packet) card.transfer(byte);
  return card.transfer(0xff);
}

test('SD image supports SPI initialization, sector reads, and persistent writes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rp2040js-sd-'));
  const image = path.join(directory, 'card.img');
  const fd = fs.openSync(image, 'w');
  fs.ftruncateSync(fd, 1024 * 1024);
  fs.closeSync(fd);
  t.after(() => {
    fs.unlinkSync(image);
    fs.rmdirSync(directory);
  });

  const card = new SDCardImage({ image, chipSelect: 17 });
  t.after(() => card.close());
  card.setSelected(true);

  assert.equal(command(card, 0), 1);
  assert.equal(command(card, 8, 0x1aa), 1);
  assert.deepEqual(
    Array.from({ length: 4 }, () => card.transfer(0xff)),
    [0, 0, 1, 0xaa]
  );
  assert.equal(command(card, 55), 1);
  assert.equal(command(card, 41), 0);
  assert.equal(command(card, 58), 0);
  assert.deepEqual(
    Array.from({ length: 4 }, () => card.transfer(0xff)),
    [0x80, 0xff, 0x80, 0]
  );

  const initialSector = Buffer.alloc(512, 0x5a);
  fs.writeSync(card.fd, initialSector, 0, initialSector.length, 0);
  assert.equal(command(card, 17, 0), 0);
  assert.equal(card.transfer(0xff), 0xff);
  assert.equal(card.transfer(0xff), 0xfe);
  const readSector = Buffer.from(Array.from({ length: 512 }, () => card.transfer(0xff)));
  assert.deepEqual(readSector, initialSector);
  card.transfer(0xff);
  card.transfer(0xff);

  const writtenSector = Buffer.alloc(512, 0xa5);
  assert.equal(command(card, 24, 512), 0);
  card.transfer(0xfe);
  for (const byte of writtenSector) card.transfer(byte);
  card.transfer(0);
  card.transfer(0);
  assert.equal(card.transfer(0xff), 0x05);
  card.transfer(0xff);
  card.transfer(0xff);

  const persistedSector = Buffer.alloc(512);
  fs.readSync(card.fd, persistedSector, 0, persistedSector.length, 512);
  assert.deepEqual(persistedSector, writtenSector);

  const firstMultiRead = Buffer.alloc(512, 0x31);
  const secondMultiRead = Buffer.alloc(512, 0x32);
  fs.writeSync(card.fd, firstMultiRead, 0, firstMultiRead.length, 1024);
  fs.writeSync(card.fd, secondMultiRead, 0, secondMultiRead.length, 1536);
  assert.equal(command(card, 18, 1024), 0);
  for (const expected of [firstMultiRead, secondMultiRead]) {
    assert.equal(card.transfer(0xff), 0xff);
    assert.equal(card.transfer(0xff), 0xfe);
    const data = Buffer.from(Array.from({ length: 512 }, () => card.transfer(0xff)));
    assert.deepEqual(data, expected);
    card.transfer(0xff);
    card.transfer(0xff);
  }
  for (const byte of [0x4c, 0, 0, 0, 0, 0xff]) card.transfer(byte);
  assert.equal(card.transfer(0xff), 0xff);
  assert.equal(card.transfer(0xff), 0);

  const firstMultiWrite = Buffer.alloc(512, 0x41);
  const secondMultiWrite = Buffer.alloc(512, 0x42);
  assert.equal(command(card, 25, 2048), 0);
  for (const block of [firstMultiWrite, secondMultiWrite]) {
    card.transfer(0xfc);
    for (const byte of block) card.transfer(byte);
    card.transfer(0);
    card.transfer(0);
    assert.equal(card.transfer(0xff), 0x05);
    card.transfer(0xff);
    card.transfer(0xff);
  }
  card.transfer(0xfd);
  const multiWritten = Buffer.alloc(1024);
  fs.readSync(card.fd, multiWritten, 0, multiWritten.length, 2048);
  assert.deepEqual(multiWritten, Buffer.concat([firstMultiWrite, secondMultiWrite]));
});

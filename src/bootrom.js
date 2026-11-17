const fs = require('node:fs');
const path = require('node:path');

const BOOTROM_SIZE_BYTES = 16 * 1024;
const bootromBuffer = fs.readFileSync(path.join(__dirname, '..', 'firmware', 'bootrom.bin'));

if (bootromBuffer.byteLength !== BOOTROM_SIZE_BYTES) {
  throw new RangeError(`RP2040 boot ROM must be exactly ${BOOTROM_SIZE_BYTES} bytes`);
}

const bootromView = new DataView(
  bootromBuffer.buffer,
  bootromBuffer.byteOffset,
  bootromBuffer.byteLength
);
const bootromB1 = new Uint32Array(BOOTROM_SIZE_BYTES / Uint32Array.BYTES_PER_ELEMENT);

for (let offset = 0; offset < bootromBuffer.byteLength; offset += Uint32Array.BYTES_PER_ELEMENT) {
  bootromB1[offset / Uint32Array.BYTES_PER_ELEMENT] = bootromView.getUint32(offset, true);
}

exports.bootromB1 = bootromB1;

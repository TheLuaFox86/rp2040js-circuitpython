const { parentPort, workerData } = require('node:worker_threads');
const { GPIOPinState } = require('rp2040js');
const { ST7789 } = require('./st7789');

const gpio = Array.from({ length: 32 }, () => ({
  value: GPIOPinState.High,
  addListener() {},
}));
const display = new ST7789({ gpio }, {
  width: workerData.width,
  height: workerData.height,
  pins: { chipSelect: 13, dataCommand: 14, reset: 15 },
}, (frame) => parentPort.postMessage({ type: 'frame', frame }));

parentPort.on('message', (message) => {
  if (message.type === 'reset') {
    display.reset();
    return;
  }
  if (message.type !== 'transaction') return;
  for (const segment of message.segments) {
    if (segment.isData) {
      for (const byte of segment.bytes) display.writeData(byte);
    } else {
      for (const byte of segment.bytes) display.writeCommand(byte);
    }
  }
  display.flushFrame();
});

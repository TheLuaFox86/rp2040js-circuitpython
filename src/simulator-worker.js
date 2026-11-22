const { parentPort } = require('node:worker_threads');
const { BOARD_CONFIG, createSimulator } = require('./index');

function sendSerialData(value) {
  let bytes;
  if (typeof value === 'number') bytes = Uint8Array.of(value & 0xff);
  else if (typeof value === 'string') bytes = Uint8Array.from(Buffer.from(value, 'utf8'));
  else if (value instanceof Uint8Array) bytes = Uint8Array.from(value);
  else return;
  parentPort.postMessage({ type: 'serial-output', bytes }, [bytes.buffer]);
}

const config = {
  ...BOARD_CONFIG,
  workerMode: true,
  serial: { ...BOARD_CONFIG.serial, port: 0 },
  web: { enabled: false },
  onSerialData: sendSerialData,
};
const simulator = createSimulator(config);

if (simulator.tft) {
  simulator.tft.onFrame = (frame) => parentPort.postMessage({ type: 'frame', frame });
  simulator.tft.flushFrame();
}

parentPort.on('message', (message) => {
  if (message.type === 'serial-input') {
    simulator.enqueueSerialBytes(message.bytes);
  } else if (message.type === 'key') {
    simulator.cardkb?.pressKey(message.key);
  } else if (message.type === 'stop') {
    simulator.stop();
    parentPort.close();
  }
});

simulator.start();
parentPort.postMessage({ type: 'ready' });

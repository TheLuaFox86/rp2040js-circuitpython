const { createSimulator } = require('./simulator');

const BOARD_CONFIG = {
  clockHz: 125_000_000,
  firmwarePath: 'firmware/firm.uf2',
  firmwareEntryPoint: 0x10000000,
  internalFilesystem: {
    imagePath: 'firmware/firmfs.img',
    flashOffset: 1024 * 1024,
  },
  serial: {
    host: process.env.SERIAL_HOST || '127.0.0.1',
    port: Number(process.env.SERIAL_PORT) || 3232,
  },
  gdbPort: Number(process.env.GDB_PORT) || 3333,
  spi: {
    controller: 0,
    pins: {
      sck: 18,
      mosi: 19,
      miso: 16,
    },
    cards: [],
  },
  onReset(resetCount) {
    console.log(`[reset #${resetCount}] at time ${Date.now()}`);
  },
  onUSBConnected(cdc) {
    console.error('CDC_CONNECTED', cdc.initialized, cdc.inEndpoint, cdc.outEndpoint);
  },
};

if (require.main === module) {
  const simulator = createSimulator(BOARD_CONFIG);
  simulator.start();
  process.on('SIGINT', () => simulator.stop());
}

module.exports = { BOARD_CONFIG, createSimulator };

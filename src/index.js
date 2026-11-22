const { createSimulator } = require('./simulator');

const BOARD_CONFIG = {
  clockHz: 133_000_000,
  // Permit larger bursts for display-heavy firmware; simulator.js still yields
  // after a short wall-clock slice so telnet and WebUI stay responsive.
  cyclesPerTick: 1_000_000,
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
    cards: [
      { image: 'firmware/InternalSD.img', chipSelect: 17 },
    ],
    pins: {
      sck: 18,
      mosi: 19,
      miso: 16,
    },
  },
  tft: {
    enabled: true,
    controller: 0,
    width: 160,
    height: 128,
    pins: {
      chipSelect: 13,
      dataCommand: 14,
      reset: 15,
    },
  },
  cardkb: {
    enabled: true,
    controller: 0,
    address: 0x5f,
  },
  web: {
    enabled: true,
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT) || 8080,
  },
  onReset(resetCount) {
    console.log(`[reset #${resetCount}] at time ${Date.now()}`);
  },
  onUSBConnected(cdc) {
    console.error('CDC_CONNECTED', cdc.initialized, cdc.inEndpoint, cdc.outEndpoint);
  },
};

if (require.main === module) {
  const { startWorkerRuntime } = require('./worker-runtime');
  const simulator = startWorkerRuntime(BOARD_CONFIG);
  process.on('SIGINT', () => simulator.stop());
}

module.exports = { BOARD_CONFIG, createSimulator };

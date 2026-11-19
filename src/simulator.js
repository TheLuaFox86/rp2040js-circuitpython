const fs = require('fs');
const { performance } = require('perf_hooks');
const { RP2040, ConsoleLogger, LogLevel, USBCDC, GPIOPinState } = require('rp2040js');
const { GDBTCPServer } = require('rp2040js/gdb-tcp-server');
const { loadUF2 } = require('./load-uf2');
const { bootromB1 } = require('./bootrom');
const { startTcpConsole } = require('./tcp-console');
const { createGPIOApi } = require('./gpio-api');
const { SDCardImage } = require('./sd-card');
const { SPIPeripheral } = require('./spi0');
const { CardKB, CARDKB_ADDRESS } = require('./cardkb');
const { ST7789 } = require('./st7789');
const { startWebUI } = require('./web-ui');

const CYCLES_PER_TICK = 100_000;
const MAX_ELAPSED_MS = 50;
const USBCTRL_IRQ = 5;
const USB_HOST_POLL_INTERVAL_MS = 100;
const USB_HOST_IRQ_PULSE_MS = 20;

function createExecutionLoop(rp2040, clockHz, onTick, shouldServiceUsb) {
  if (typeof rp2040.executeInstruction !== 'function') {
    throw new Error('The installed rp2040js version does not expose executeInstruction()');
  }

  let running = false;
  let immediate = null;
  let lastTime = 0;
  let cycleDebt = 0;
  let usbHostPoll = null;
  let usbIrqClear = null;

  // TinyUSB flushes CDC writes from background work queued by USB interrupts.
  // rp2040js has no periodic host polling, so pulse USBCTRL while CDC is active.
  function clearUsbHostIrq() {
    rp2040.setInterrupt(USBCTRL_IRQ, false);
    if (running && rp2040.usbCtrl.intStatus) {
      rp2040.setInterrupt(USBCTRL_IRQ, true);
    }
  }

  function pollUsbHost() {
    if (!running || !shouldServiceUsb() || usbIrqClear !== null) return;
    rp2040.setInterrupt(USBCTRL_IRQ, true);
    usbIrqClear = setTimeout(() => {
      clearUsbHostIrq();
      usbIrqClear = null;
    }, USB_HOST_IRQ_PULSE_MS);
  }

  function tick() {
    immediate = null;
    if (!running) return;
    onTick();

    const now = performance.now();
    const elapsedMs = Math.min(now - lastTime, MAX_ELAPSED_MS);
    lastTime = now;
    cycleDebt = Math.min(
      cycleDebt + elapsedMs * clockHz / 1000,
      clockHz * MAX_ELAPSED_MS / 1000
    );

    const budget = Math.min(Math.floor(cycleDebt), CYCLES_PER_TICK);
    if (budget > 0) {
      if (rp2040.waiting) {
        cycleDebt -= budget;
      } else {
        let executed = 0;
        while (executed < budget && running && !rp2040.waiting) {
          const previousCycles = rp2040.cycles;
          rp2040.executeInstruction();
          const instructionCycles = rp2040.cycles - previousCycles;
          executed += instructionCycles > 0 ? instructionCycles : 1;
        }
        cycleDebt = Math.max(0, cycleDebt - executed);
      }
    }

    if (running) immediate = setImmediate(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      rp2040.stopped = false;
      rp2040.clock.resume();
      lastTime = performance.now();
      usbHostPoll = setInterval(pollUsbHost, USB_HOST_POLL_INTERVAL_MS);
      immediate = setImmediate(tick);
    },
    stop() {
      running = false;
      if (immediate !== null) clearImmediate(immediate);
      immediate = null;
      if (usbHostPoll !== null) clearInterval(usbHostPoll);
      usbHostPoll = null;
      if (usbIrqClear !== null) {
        clearTimeout(usbIrqClear);
        usbIrqClear = null;
        clearUsbHostIrq();
      }
      cycleDebt = 0;
      rp2040.clock.pause();
    },
  };
}

function createSimulator(config) {
  if (!config || !Number.isFinite(config.clockHz) || config.clockHz <= 0) {
    throw new TypeError('Simulator config requires a positive clockHz');
  }
  if (!config.firmwarePath ||
    typeof config.serial?.host !== 'string' ||
    !config.serial.host ||
    !Number.isInteger(config.serial.port) ||
    config.serial.port < 0 ||
    config.serial.port > 65535) {
    throw new TypeError('Simulator config requires firmwarePath and serial host/port settings');
  }
  if (!Number.isInteger(config.gdbPort) || config.gdbPort < 0 || config.gdbPort > 65535) {
    throw new TypeError('Simulator config requires a valid gdbPort');
  }
  if (config.onGPIOChange !== undefined && typeof config.onGPIOChange !== 'function') {
    throw new TypeError('onGPIOChange must be a function');
  }
  if (config.onReset !== undefined && typeof config.onReset !== 'function') {
    throw new TypeError('onReset must be a function');
  }
  if (config.onUSBConnected !== undefined && typeof config.onUSBConnected !== 'function') {
    throw new TypeError('onUSBConnected must be a function');
  }
  if (config.web !== undefined) {
    if (!config.web || typeof config.web !== 'object') {
      throw new TypeError('web config must be an object');
    }
    if (config.web.enabled !== undefined && typeof config.web.enabled !== 'boolean') {
      throw new TypeError('web enabled must be a boolean');
    }
    if (config.web.enabled) {
      const host = config.web.host ?? '127.0.0.1';
      const port = config.web.port ?? 8080;
      if (typeof host !== 'string' || !host ||
        !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new TypeError('web config requires a host and valid port');
      }
    }
  }

  const rp2040 = new RP2040();
  rp2040.loadBootrom(bootromB1);
  rp2040.logger = new ConsoleLogger(LogLevel.Off);
  loadUF2(config.firmwarePath, rp2040);
  if (config.firmwareEntryPoint !== undefined) {
    if (!Number.isInteger(config.firmwareEntryPoint)) {
      throw new TypeError('firmwareEntryPoint must be an integer address');
    }
    // The current rp2040js ROM model waits before completing the XIP boot path.
    rp2040.PC = config.firmwareEntryPoint;
  }

  if (config.internalFilesystem?.imagePath && fs.existsSync(config.internalFilesystem.imagePath)) {
    const image = fs.readFileSync(config.internalFilesystem.imagePath);
    const { flashOffset } = config.internalFilesystem;
    if (!Number.isInteger(flashOffset) || flashOffset < 0 || flashOffset + image.length > rp2040.flash.length) {
      throw new RangeError(`Internal filesystem image does not fit in flash: ${config.internalFilesystem.imagePath}`);
    }
    rp2040.flash.set(image, flashOffset);
  }

  let resetCount = 0;
  const resetCore = rp2040.reset.bind(rp2040);
  rp2040.reset = function reset() {
    const flash = rp2040.flash.slice();
    resetCore();
    rp2040.flash.set(flash);
    if (config.firmwareEntryPoint !== undefined) {
      rp2040.PC = config.firmwareEntryPoint;
    }
    resetCount++;
    config.onReset?.(resetCount);
  };

  const cdc = new USBCDC(rp2040.usbCtrl);
  cdc.dtr = true;
  cdc.onDeviceConnected = () => config.onUSBConnected?.(cdc);
  const gpio = createGPIOApi(rp2040, config.onGPIOChange);

  const spiConfig = config.spi || {};
  const spiIndex = spiConfig.controller ?? 0;
  if (spiIndex !== 0 && spiIndex !== 1) {
    throw new RangeError('SPI controller must be 0 or 1');
  }
  const spiPins = spiConfig.pins || {};
  const configuredPins = new Set();
  for (const [name, pin] of Object.entries(spiPins)) {
    if (!Number.isInteger(pin) || pin < 0 || pin >= rp2040.gpio.length) {
      throw new RangeError(`Invalid SPI ${name.toUpperCase()} GPIO: ${pin}`);
    }
    if (configuredPins.has(pin)) throw new Error(`SPI pins cannot share GPIO${pin}`);
    configuredPins.add(pin);
  }
  const misoPin = spiPins.miso;
  const cardConfigs = spiConfig.cards || [];
  if (!Array.isArray(cardConfigs)) {
    throw new TypeError('SPI cards must be an array');
  }
  const chipSelectPins = new Set();
  for (const cardConfig of cardConfigs) {
    if (!Number.isInteger(cardConfig.chipSelect) || cardConfig.chipSelect < 0 || cardConfig.chipSelect >= rp2040.gpio.length) {
      throw new RangeError(`Invalid SD-card chip-select GPIO: ${cardConfig.chipSelect}`);
    }
    if (chipSelectPins.has(cardConfig.chipSelect)) {
      throw new Error(`Multiple SD cards use GPIO${cardConfig.chipSelect} as chip select`);
    }
    if (configuredPins.has(cardConfig.chipSelect)) {
      throw new Error(`SD-card chip select cannot share SPI GPIO${cardConfig.chipSelect}`);
    }
    chipSelectPins.add(cardConfig.chipSelect);
  }
  const cards = [];
  try {
    for (const cardConfig of cardConfigs) cards.push(new SDCardImage(cardConfig));
  } catch (error) {
    for (const card of cards) card.close();
    throw error;
  }
  for (const card of cards) {
    const pin = rp2040.gpio[card.chipSelect];
    pin.addListener((state) => card.setSelected(state === GPIOPinState.Low));
    card.setSelected(pin.value === GPIOPinState.Low);
  }

  const tftConfig = config.tft || {};
  let tft = null;
  let cardkb = null;
  const devices = [...cards];
  const cardkbConfig = config.cardkb || {};
  try {
    if (tftConfig.enabled !== undefined && typeof tftConfig.enabled !== 'boolean') {
      throw new TypeError('TFT enabled must be a boolean');
    }
    if (cardkbConfig.enabled !== undefined && typeof cardkbConfig.enabled !== 'boolean') {
      throw new TypeError('CardKB enabled must be a boolean');
    }
    if (tftConfig.enabled) {
      if (tftConfig.controller !== undefined && tftConfig.controller !== spiIndex) {
        throw new Error('TFT controller must match the configured SPI controller');
      }
      const tftPins = {
        chipSelect: 13,
        dataCommand: 14,
        reset: 15,
        ...tftConfig.pins,
      };
      for (const [name, pin] of Object.entries(tftPins)) {
        if (!Number.isInteger(pin) || pin < 0 || pin >= rp2040.gpio.length) {
          throw new RangeError(`Invalid TFT ${name} GPIO: ${pin}`);
        }
        if (configuredPins.has(pin)) throw new Error(`TFT ${name} cannot share SPI GPIO${pin}`);
        if (name === 'chipSelect' && chipSelectPins.has(pin)) {
          throw new Error(`TFT chip select cannot share GPIO${pin} with another device`);
        }
        if (name !== 'chipSelect' && chipSelectPins.has(pin)) {
          throw new Error(`TFT ${name} cannot share GPIO${pin} with a chip select`);
        }
        configuredPins.add(pin);
      }
      if (new Set(Object.values(tftPins)).size !== Object.keys(tftPins).length) {
        throw new Error('TFT GPIO pins cannot overlap');
      }
      for (const [name, size] of [['width', tftConfig.width ?? 240], ['height', tftConfig.height ?? 240]]) {
        if (!Number.isInteger(size) || size < 1 || size > 320) {
          throw new RangeError(`TFT ${name} must be an integer from 1 to 320`);
        }
      }
      tft = new ST7789(rp2040, { ...tftConfig, pins: tftPins });
      const chipSelectPin = rp2040.gpio[tftPins.chipSelect];
      chipSelectPin.addListener((state) => {
        tft.selected = state === GPIOPinState.Low;
        if (!tft.selected) tft.flushFrame();
      });
      tft.selected = chipSelectPin.value === GPIOPinState.Low;
      chipSelectPins.add(tftPins.chipSelect);
      devices.push(tft);
    }

    if (cardkbConfig.enabled) {
      const controller = cardkbConfig.controller ?? 0;
      const address = cardkbConfig.address ?? CARDKB_ADDRESS;
      if (!Number.isInteger(controller) || controller < 0 || controller > 1) {
        throw new RangeError('CardKB I2C controller must be 0 or 1');
      }
      if (!Number.isInteger(address) || address < 0x08 || address > 0x77) {
        throw new RangeError('CardKB I2C address must be a 7-bit address');
      }
      cardkb = new CardKB(rp2040.i2c[controller], address);
    }
  } catch (error) {
    for (const card of cards) card.close();
    throw error;
  }

  rp2040.peripherals[0x4003c + spiIndex * 4] = new SPIPeripheral(rp2040, devices, misoPin);

  const inputQueue = [];
  let inputHead = 0;
  const executionLoop = createExecutionLoop(rp2040, config.clockHz, pumpInput, () => cdc.initialized);
  const originalStop = rp2040.stop.bind(rp2040);
  rp2040.stop = function stop() {
    executionLoop.stop();
    originalStop();
  };
  rp2040.execute = function execute() {
    executionLoop.start();
  };

  let tcpConsole;
  let webUI;
  let gdbServer;
  const gdbClients = new Set();
  let started = false;
  let disposed = false;

  cdc.onSerialData = (value) => {
    if (typeof value === 'number') {
      tcpConsole?.write(Buffer.from([value & 0xff]));
    } else if (typeof value === 'string') {
      tcpConsole?.write(Buffer.from(value, 'utf8'));
    } else if (value instanceof Uint8Array) {
      tcpConsole?.write(Buffer.from(value));
    }
  };

  function pumpInput() {
    let sent = 0;
    while (inputHead < inputQueue.length && sent < 64) {
      cdc.sendSerialByte(inputQueue[inputHead++]);
      sent++;
    }
    if (inputHead === inputQueue.length) {
      inputQueue.length = 0;
      inputHead = 0;
    } else if (inputHead > 1024) {
      inputQueue.splice(0, inputHead);
      inputHead = 0;
    }
  }

  function start() {
    if (started) throw new Error('Simulator is already running');
    if (disposed) throw new Error('Simulator has already been stopped');
    tcpConsole = startTcpConsole({
      ...config.serial,
      onSerialBytes(bytes) {
        for (const byte of bytes) inputQueue.push(byte);
      },
    });
    try {
      gdbServer = new GDBTCPServer(rp2040, config.gdbPort);
      gdbServer.socketServer.on('connection', (socket) => {
        gdbClients.add(socket);
        socket.once('close', () => gdbClients.delete(socket));
      });
    } catch (error) {
      tcpConsole.close();
      tcpConsole = undefined;
      throw error;
    }
    if (config.web?.enabled === true) {
      const webConfig = config.web || {};
      webUI = startWebUI({
        host: webConfig.host || '127.0.0.1',
        port: webConfig.port ?? 8080,
        tftEnabled: !!tft,
        cardkbEnabled: !!cardkb,
        onKey(key) {
          cardkb.pressKey(key);
        },
        getFrame() {
          return webUI?.getFrame();
        },
      });
      if (tft) {
        tft.onFrame = (frame) => webUI?.publishFrame(frame);
        tft.flushFrame();
      }
    }
    started = true;
    executionLoop.start();
    return simulator;
  }

  function stop() {
    if (disposed) return;
    disposed = true;
    started = false;
    rp2040.stop();
    tcpConsole?.close();
    webUI?.close();
    for (const socket of gdbClients) socket.destroy();
    gdbServer?.socketServer?.close();
    for (const card of cards) card.close();
  }

  const simulator = {
    rp2040,
    cdc,
    gpio,
    tft,
    cardkb,
    start,
    stop,
    get servers() {
      return {
        serial: tcpConsole?.server,
        gdb: gdbServer?.socketServer,
        web: webUI?.server,
      };
    },
  };
  return simulator;
}

module.exports = { createSimulator };

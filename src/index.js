const fs = require('fs');
const { performance } = require('perf_hooks');
const { RP2040, ConsoleLogger, LogLevel, USBCDC } = require('rp2040js');
const { loadUF2 } = require('./load-uf2');
const { bootromB1 } = require('./bootrom');
const { GDBTCPServer } = require('rp2040js/gdb-tcp-server');
const { startTcpConsole } = require('./tcp-console');

const mcu = new RP2040();
mcu.loadBootrom(bootromB1);
mcu.logger = new ConsoleLogger(LogLevel.Off);

// 1. Load CircuitPython firmware UF2
loadUF2('firmware/firm.uf2', mcu);

// 2. Load the FAT12 filesystem image silently
const fatImagePath = 'fat12.img';
if (fs.existsSync(fatImagePath)) {
  const fatBuffer = fs.readFileSync(fatImagePath);
  const flashOffset = 1024 * 1024;
  if (flashOffset + fatBuffer.length <= mcu.flash.length) {
    mcu.flash.set(new Uint8Array(fatBuffer), flashOffset);
  }
}

const cdc = new USBCDC(mcu.usbCtrl);
cdc.onDeviceConnected = () => console.error("CDC_CONNECTED", cdc.initialized, cdc.inEndpoint, cdc.outEndpoint);
cdc.dtr = true;


 // --- RESPONSIVE USB CDC STREAMING ---

const inputQueue = [];
let inputHead = 0;

const tcpConsole = startTcpConsole({
  host: process.env.SERIAL_HOST || '127.0.0.1',
  port: Number(process.env.SERIAL_PORT) || 2323,
  onSerialBytes(bytes) {
    for (const byte of bytes) inputQueue.push(byte);
  },
});

const CYCLES_PER_MS = 133000;
const MAX_CYCLES_PER_TICK = 100000;
const MAX_INPUT_PER_TICK = 64;

let lastTime = performance.now();
let cycleDebt = 0;

// Stream CircuitPython's USB serial output to the TCP console.
cdc.onSerialData = (value) => {
  let bytes;
  if (typeof value === 'number') {
    bytes = Buffer.from([value & 0xff]);
  } else if (typeof value === 'string') {
    bytes = Buffer.from(value, 'utf8');
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else {
    return;
  }
  tcpConsole.write(bytes);
};

// GDB server.
const gdbServer = new GDBTCPServer(
  mcu,
  Number(process.env.GDB_PORT) || 3333
);

mcu.PC = 0x10000000;

// Main emulator loop.
function emu() {
  const now = performance.now();
  const delta = Math.min(now - lastTime, 50);
  lastTime = now;

  cycleDebt = Math.min(
    cycleDebt + delta * CYCLES_PER_MS,
    CYCLES_PER_MS * 50
  );

  try {
    // Execute CPU instructions in smaller batches.
    const cycles = Math.min(
      Math.floor(cycleDebt),
      MAX_CYCLES_PER_TICK
    );

    if (cycles > 0) {
      mcu.execute(cycles);
      cycleDebt -= cycles;
    }

    // Send multiple keyboard bytes per iteration.
    let sent = 0;

    while (
      inputHead < inputQueue.length &&
      sent < MAX_INPUT_PER_TICK
    ) {
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

  } catch (err) {
    console.error('\nEMU ERROR:', err.stack || err);
    process.exit(1);
  }

  setImmediate(emu);
}

setImmediate(emu);

const { BasePeripheral } = require('rp2040js');

const DATA_REGISTER = 0x08;
const FIFO_DEPTH = 8;

const INTERRUPT_RX_OVERFLOW = 1 << 0;
const INTERRUPT_RX = 1 << 2;
const INTERRUPT_TX = 1 << 3;

class SPIPeripheral extends BasePeripheral {
  constructor(rp2040, devices, misoPin) {
    super(rp2040, 'SPI_SD_BUS');
    this.devices = devices;
    this.misoPin = misoPin;
    this.resetRegisters();
  }

  resetRegisters() {
    this.ctrlr0 = 0x7;
    this.ctrlr1 = 0;
    this.baudr = 0;
    this.interruptMask = 0;
    this.rawInterruptStatus = 0;
    this.dmaControl = 0;
    this.rxFifo = [];
  }

  get enabled() {
    return !!(this.ctrlr1 & 0x2);
  }

  get status() {
    return 0x3 | (this.rxFifo.length ? 0x4 : 0) |
      (this.rxFifo.length >= FIFO_DEPTH ? 0x8 : 0);
  }

  readData() {
    if (!this.rxFifo.length) {
      return 0;
    }
    const value = this.rxFifo.shift();
    this.updateFifoInterrupts();
    return value;
  }

  updateFifoInterrupts() {
    if (this.rxFifo.length) {
      this.rawInterruptStatus |= INTERRUPT_RX;
    } else {
      this.rawInterruptStatus &= ~INTERRUPT_RX;
    }
    this.rawInterruptStatus |= INTERRUPT_TX;
  }

  readUint32(offset) {
    // RP2040 APB peripherals expose XOR, SET, and CLR aliases in the next
    // three 4 KiB windows. Reads through an alias return the base register.
    offset &= 0x0fff;
    if (offset === DATA_REGISTER) {
      return this.readData();
    }
    switch (offset) {
      case 0x00: return this.ctrlr0;
      case 0x04: return this.ctrlr1;
      case 0x0c: return this.status;
      case 0x10: return this.baudr;
      case 0x14: return this.interruptMask;
      case 0x18: return this.rawInterruptStatus;
      case 0x1c: return this.rawInterruptStatus & this.interruptMask;
      case 0x20:
        this.rawInterruptStatus = 0;
        return 0;
      case 0x24: return this.dmaControl;
      default: return super.readUint32(offset);
    }
  }

  writeUint32(offset, value) {
    if (offset === DATA_REGISTER) {
      this.writeData(value);
      return;
    }
    switch (offset) {
      case 0x00: this.ctrlr0 = value; break;
      case 0x04: this.ctrlr1 = value; break;
      case 0x10: this.baudr = value; break;
      case 0x14: this.interruptMask = value & 0xf; break;
      case 0x20: this.rawInterruptStatus = 0; break;
      case 0x24: this.dmaControl = value & 0x3; break;
      default: super.writeUint32(offset, value);
    }
  }

  writeData(value) {
    if (!this.enabled) return;
    if (this.rxFifo.length >= FIFO_DEPTH) {
      this.rawInterruptStatus |= INTERRUPT_RX_OVERFLOW;
      return;
    }

    const frameBits = (this.ctrlr0 & 0xf) + 1;
    const frameBytes = Math.ceil(frameBits / 8);
    let received = 0;
    for (let index = 0; index < frameBytes; index++) {
      const shift = (frameBytes - index - 1) * 8;
      const transmitByte = (value >>> shift) & 0xff;
      const receiveByte = this.transferByte(transmitByte);
      received = (received << 8) | receiveByte;
    }

    this.rxFifo.push(received & ((1 << frameBits) - 1));
    this.updateFifoInterrupts();
  }

  transferByte(transmitByte) {
    let receiveByte = 0xff;
    for (const device of this.devices) {
      if (device.selected) receiveByte &= device.transfer(transmitByte);
    }
    if (this.misoPin !== undefined) {
      const pin = this.rp2040.gpio[this.misoPin];
      pin.setInputValue(!!(receiveByte & 1));
      pin.checkForUpdates();
    }
    return receiveByte;
  }
}

module.exports = { SPIPeripheral };

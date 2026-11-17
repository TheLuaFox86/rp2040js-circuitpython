const { BasePeripheral } = require('rp2040js');

const DATA_REGISTER_FIRST = 0x60;
const DATA_REGISTER_LAST = 0xdc;
const FIFO_DEPTH = 8;

const INTERRUPT_TX = 1 << 0;
const INTERRUPT_RX_UNDERFLOW = 1 << 2;
const INTERRUPT_RX_OVERFLOW = 1 << 3;
const INTERRUPT_RX = 1 << 4;

class SPIPeripheral extends BasePeripheral {
  constructor(rp2040, cards, misoPin) {
    super(rp2040, 'SPI_SD_BUS');
    this.cards = cards;
    this.misoPin = misoPin;
    this.resetRegisters();
  }

  resetRegisters() {
    this.ctrlr0 = 0x7;
    this.ctrlr1 = 0;
    this.enable = 0;
    this.mwcr = 0;
    this.slaveEnable = 0;
    this.baudr = 0;
    this.txThreshold = 0;
    this.rxThreshold = 0;
    this.interruptMask = 0;
    this.rawInterruptStatus = 0;
    this.dmaControl = 0;
    this.dmaTxLevel = 0;
    this.dmaRxLevel = 0;
    this.rxSampleDelay = 0;
    this.rxFifo = [];
  }

  get status() {
    return 0x4 | 0x2 | (this.rxFifo.length ? 0x8 : 0) |
      (this.rxFifo.length >= FIFO_DEPTH ? 0x10 : 0);
  }

  readData() {
    if (!this.rxFifo.length) {
      this.rawInterruptStatus |= INTERRUPT_RX_UNDERFLOW;
      return 0;
    }
    const value = this.rxFifo.shift();
    this.updateFifoInterrupts();
    return value;
  }

  updateFifoInterrupts() {
    if (this.rxFifo.length > this.rxThreshold) {
      this.rawInterruptStatus |= INTERRUPT_RX;
    } else {
      this.rawInterruptStatus &= ~INTERRUPT_RX;
    }
    this.rawInterruptStatus |= INTERRUPT_TX;
  }

  readUint32(offset) {
    if (offset >= DATA_REGISTER_FIRST && offset <= DATA_REGISTER_LAST) {
      return this.readData();
    }
    switch (offset) {
      case 0x00: return this.ctrlr0;
      case 0x04: return this.ctrlr1;
      case 0x08: return this.enable;
      case 0x0c: return this.mwcr;
      case 0x10: return this.slaveEnable;
      case 0x14: return this.baudr;
      case 0x18: return this.txThreshold;
      case 0x1c: return this.rxThreshold;
      case 0x20: return 0;
      case 0x24: return this.rxFifo.length;
      case 0x28: return this.status;
      case 0x2c: return this.interruptMask;
      case 0x30: return this.rawInterruptStatus & this.interruptMask;
      case 0x34: return this.rawInterruptStatus;
      case 0x38:
      case 0x3c:
      case 0x40:
        this.rawInterruptStatus = 0;
        return 0;
      case 0x44:
        this.rawInterruptStatus = 0;
        return 0;
      case 0x48:
        this.rawInterruptStatus = 0;
        return 0;
      case 0x4c: return this.dmaControl;
      case 0x50: return this.dmaTxLevel;
      case 0x54: return this.dmaRxLevel;
      case 0x58: return 0x44570140;
      case 0x5c: return 0x3230312a;
      case 0xf0: return this.rxSampleDelay;
      default: return super.readUint32(offset);
    }
  }

  writeUint32(offset, value) {
    if (offset >= DATA_REGISTER_FIRST && offset <= DATA_REGISTER_LAST) {
      this.writeData(value);
      return;
    }
    switch (offset) {
      case 0x00: this.ctrlr0 = value; break;
      case 0x04: this.ctrlr1 = value; break;
      case 0x08: this.enable = value & 1; break;
      case 0x0c: this.mwcr = value; break;
      case 0x10: this.slaveEnable = value; break;
      case 0x14: this.baudr = value; break;
      case 0x18: this.txThreshold = value & 0x7; break;
      case 0x1c: this.rxThreshold = value & 0x7; break;
      case 0x2c: this.interruptMask = value & 0x3f; break;
      case 0x4c: this.dmaControl = value & 0x3; break;
      case 0x50: this.dmaTxLevel = value & 0x1f; break;
      case 0x54: this.dmaRxLevel = value & 0x1f; break;
      case 0x48: this.rawInterruptStatus = 0; break;
      case 0xf0: this.rxSampleDelay = value & 0xff; break;
      default: super.writeUint32(offset, value);
    }
  }

  writeData(value) {
    if (!this.enable) return;
    if (this.rxFifo.length >= FIFO_DEPTH) {
      this.rawInterruptStatus |= INTERRUPT_RX_OVERFLOW;
      return;
    }

    const frameBits = (this.ctrlr0 & 0xf) + 1;
    const frameBytes = Math.ceil(frameBits / 8);
    const transferMode = (this.ctrlr0 >> 10) & 0x3;
    let received = 0;
    for (let index = 0; index < frameBytes; index++) {
      const shift = (frameBytes - index - 1) * 8;
      const transmitByte = transferMode === 1 ? 0 : (value >>> shift) & 0xff;
      const receiveByte = this.transferByte(transmitByte);
      received = (received << 8) | receiveByte;
    }

    if (transferMode !== 2) {
      this.rxFifo.push(received & ((1 << frameBits) - 1));
      this.updateFifoInterrupts();
    }
  }

  transferByte(transmitByte) {
    let receiveByte = 0xff;
    for (const card of this.cards) {
      if (card.selected) receiveByte &= card.transfer(transmitByte);
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

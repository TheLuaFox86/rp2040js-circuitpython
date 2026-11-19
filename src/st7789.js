const { GPIOPinState } = require('rp2040js');

const COMMAND_MEMORY_WRITE = 0x2c;
const COMMAND_COLUMN_ADDRESS = 0x2a;
const COMMAND_ROW_ADDRESS = 0x2b;

class ST7789 {
  constructor(rp2040, config, onFrame = () => {}) {
    this.rp2040 = rp2040;
    this.width = config.width ?? 240;
    this.height = config.height ?? 240;
    this.chipSelect = config.pins.chipSelect;
    this.dataCommand = config.pins.dataCommand;
    this.resetPin = config.pins.reset;
    this.onFrame = onFrame;
    this.selected = false;
    this.dirty = false;
    this.reset();

    rp2040.gpio[this.resetPin].addListener((state) => {
      if (state === GPIOPinState.Low) this.reset();
    });
  }

  reset() {
    this.pixels = new Uint16Array(this.width * this.height);
    this.command = null;
    this.parameters = [];
    this.columnStart = 0;
    this.columnEnd = this.width - 1;
    this.rowStart = 0;
    this.rowEnd = this.height - 1;
    this.cursorX = 0;
    this.cursorY = 0;
    this.pixelHighByte = null;
    this.dirty = true;
  }

  transfer(value) {
    const isData = this.rp2040.gpio[this.dataCommand].value === GPIOPinState.High;
    if (isData) this.writeData(value);
    else this.writeCommand(value);
    return 0xff;
  }

  writeCommand(command) {
    this.command = command;
    this.parameters = [];
    if (command === COMMAND_MEMORY_WRITE) {
      this.cursorX = this.columnStart;
      this.cursorY = this.rowStart;
      this.pixelHighByte = null;
    }
    if (this.dirty && command !== COMMAND_MEMORY_WRITE) this.flushFrame();
  }

  writeData(value) {
    if (this.command === COMMAND_MEMORY_WRITE) {
      this.writePixelByte(value);
      return;
    }
    this.parameters.push(value);
    if (this.command === COMMAND_COLUMN_ADDRESS && this.parameters.length === 4) {
      this.columnStart = (this.parameters[0] << 8) | this.parameters[1];
      this.columnEnd = (this.parameters[2] << 8) | this.parameters[3];
      this.parameters = [];
    } else if (this.command === COMMAND_ROW_ADDRESS && this.parameters.length === 4) {
      this.rowStart = (this.parameters[0] << 8) | this.parameters[1];
      this.rowEnd = (this.parameters[2] << 8) | this.parameters[3];
      this.parameters = [];
    }
  }

  writePixelByte(value) {
    if (this.pixelHighByte === null) {
      this.pixelHighByte = value;
      return;
    }
    const columnOffset = this.columnEnd >= this.width ? this.columnStart : 0;
    const rowOffset = this.rowEnd >= this.height ? this.rowStart : 0;
    const x = this.cursorX - columnOffset;
    const y = this.cursorY - rowOffset;
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      this.pixels[y * this.width + x] =
        (this.pixelHighByte << 8) | value;
      this.dirty = true;
    }
    this.pixelHighByte = null;
    this.cursorX++;
    if (this.cursorX > this.columnEnd) {
      this.cursorX = this.columnStart;
      this.cursorY++;
      if (this.cursorY > this.rowEnd) this.cursorY = this.rowStart;
    }
  }

  flushFrame() {
    if (!this.dirty) return;
    this.dirty = false;
    this.onFrame({
      width: this.width,
      height: this.height,
      pixels: Buffer.from(this.pixels.buffer).toString('base64'),
    });
  }
}

module.exports = { ST7789 };

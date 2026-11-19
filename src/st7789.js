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
    this.fullFrameDirty = true;
    this.dirtyBounds = null;
  }

  transfer(value) {
    const isData = this.rp2040.gpio[this.dataCommand].value === GPIOPinState.High;
    if (isData) this.writeData(value);
    else this.writeCommand(value);
    return 0xff;
  }

  transferBuffer(bytes) {
    const isData = this.rp2040.gpio[this.dataCommand].value === GPIOPinState.High;
    if (!isData) {
      for (const byte of bytes) this.writeCommand(byte);
    } else if (this.command === COMMAND_MEMORY_WRITE) {
      this.writePixelBytes(bytes);
    } else {
      for (const byte of bytes) this.writeData(byte);
    }
    return new Uint8Array(bytes.length).fill(0xff);
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
    this.writePixel((this.pixelHighByte << 8) | value);
    this.pixelHighByte = null;
  }

  writePixel(value) {
    const x = this.cursorX - (this.columnEnd >= this.width ? this.columnStart : 0);
    const y = this.cursorY - (this.rowEnd >= this.height ? this.rowStart : 0);
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      const index = y * this.width + x;
      if (this.pixels[index] !== value) {
        this.pixels[index] = value;
        this.markDirty(x, y);
      }
    }
    this.cursorX++;
    if (this.cursorX > this.columnEnd) {
      this.cursorX = this.columnStart;
      this.cursorY++;
      if (this.cursorY > this.rowEnd) this.cursorY = this.rowStart;
    }
  }

  writePixelBytes(bytes) {
    const columnOffset = this.columnEnd >= this.width ? this.columnStart : 0;
    const rowOffset = this.rowEnd >= this.height ? this.rowStart : 0;
    let cursorX = this.cursorX;
    let cursorY = this.cursorY;
    let highByte = this.pixelHighByte;
    let wrotePixels = false;

    for (const byte of bytes) {
      if (highByte === null) {
        highByte = byte;
        continue;
      }
      const x = cursorX - columnOffset;
      const y = cursorY - rowOffset;
      if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
        const index = y * this.width + x;
        const value = (highByte << 8) | byte;
        if (this.pixels[index] !== value) {
          this.pixels[index] = value;
          this.markDirty(x, y);
          wrotePixels = true;
        }
      }
      highByte = null;
      cursorX++;
      if (cursorX > this.columnEnd) {
        cursorX = this.columnStart;
        cursorY++;
        if (cursorY > this.rowEnd) cursorY = this.rowStart;
      }
    }

    this.cursorX = cursorX;
    this.cursorY = cursorY;
    this.pixelHighByte = highByte;
    if (wrotePixels) this.dirty = true;
  }

  markDirty(x, y) {
    this.dirty = true;
    if (this.fullFrameDirty) return;
    if (!this.dirtyBounds) {
      this.dirtyBounds = { minX: x, minY: y, maxX: x, maxY: y };
      return;
    }
    this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, x);
    this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, y);
    this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, x);
    this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, y);
  }

  flushFrame() {
    if (!this.dirty) return;
    this.dirty = false;
    const bounds = this.fullFrameDirty
      ? { minX: 0, minY: 0, maxX: this.width - 1, maxY: this.height - 1 }
      : this.dirtyBounds;
    if (!bounds) return;
    const x = bounds.minX;
    const y = bounds.minY;
    const frameWidth = bounds.maxX - x + 1;
    const frameHeight = bounds.maxY - y + 1;
    const source = Buffer.from(this.pixels.buffer, this.pixels.byteOffset, this.pixels.byteLength);
    const pixels = Buffer.alloc(frameWidth * frameHeight * 2);
    const rowBytes = frameWidth * 2;
    for (let row = 0; row < frameHeight; row++) {
      const sourceStart = ((y + row) * this.width + x) * 2;
      source.copy(pixels, row * rowBytes, sourceStart, sourceStart + rowBytes);
    }
    const full = x === 0 && y === 0 && frameWidth === this.width && frameHeight === this.height;
    this.onFrame({
      width: this.width,
      height: this.height,
      x,
      y,
      frameWidth,
      frameHeight,
      full,
      pixels: pixels.toString('base64'),
    });
    this.fullFrameDirty = false;
    this.dirtyBounds = null;
  }
}

module.exports = { ST7789 };

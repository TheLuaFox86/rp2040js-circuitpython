const { GPIOPinState } = require('rp2040js');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const COMMAND_MEMORY_WRITE = 0x2c;
const COMMAND_COLUMN_ADDRESS = 0x2a;
const COMMAND_ROW_ADDRESS = 0x2b;

class ST7789 {
  constructor(rp2040, config, onFrame = () => {}, options = {}) {
    this.rp2040 = rp2040;
    this.width = config.width ?? 240;
    this.height = config.height ?? 240;
    this.chipSelect = config.pins.chipSelect;
    this.dataCommand = config.pins.dataCommand;
    this.resetPin = config.pins.reset;
    this.onFrame = onFrame;
    this.worker = options.worker || (options.asyncRefresh
      ? new Worker(path.join(__dirname, 'st7789-worker.js'), { workerData: { width: this.width, height: this.height } })
      : null);
    this.ownsWorker = !!(this.worker && !options.worker);
    this.pendingSegments = [];
    this.worker?.on('message', (message) => {
      if (message.type === 'frame') this.onFrame(message.frame);
    });
    this.worker?.on('error', (error) => {
      console.error(`ST7789 worker error: ${error.message}`);
    });
    this.receiveBuffer = null;
    this.selected = false;
    this.dirty = false;
    this.reset();

    rp2040.gpio[this.resetPin].addListener((state) => {
      if (state === GPIOPinState.Low) this.reset();
    });
  }

  reset() {
    if (this.worker) {
      this.pendingSegments.length = 0;
      this.worker.postMessage({ type: 'reset' });
      return;
    }
    this.pixels = new Uint16Array(this.width * this.height);
    this.command = null;
    this.parameters = [];
    this.columnStart = 0;
    this.columnEnd = this.width - 1;
    this.rowStart = 0;
    this.rowEnd = this.height - 1;
    this.configureWindow();
    this.cursorX = 0;
    this.cursorY = 0;
    this.cursorIndex = this.windowStartIndex;
    this.pixelHighByte = null;
    this.dirty = true;
    this.fullFrameDirty = true;
    this.dirtyBounds = null;
  }

  transfer(value) {
    const isData = this.rp2040.gpio[this.dataCommand].value === GPIOPinState.High;
    if (this.worker) {
      this.queueWorkerByte(isData, value);
      return 0xff;
    }
    if (isData) this.writeData(value);
    else this.writeCommand(value);
    return 0xff;
  }

  transferBuffer(bytes) {
    const isData = this.rp2040.gpio[this.dataCommand].value === GPIOPinState.High;
    if (this.worker) {
      this.queueWorkerBytes(isData, bytes);
      if (!this.receiveBuffer || this.receiveBuffer.length !== bytes.length) {
        this.receiveBuffer = new Uint8Array(bytes.length);
      }
      this.receiveBuffer.fill(0xff);
      return this.receiveBuffer;
    }
    if (!isData) {
      for (const byte of bytes) this.writeCommand(byte);
    } else if (this.command === COMMAND_MEMORY_WRITE) {
      this.writePixelBytes(bytes);
    } else {
      for (const byte of bytes) this.writeData(byte);
    }
    if (!this.receiveBuffer || this.receiveBuffer.length !== bytes.length) {
      this.receiveBuffer = new Uint8Array(bytes.length);
    }
    this.receiveBuffer.fill(0xff);
    return this.receiveBuffer;
  }

  queueWorkerByte(isData, value) {
    let segment = this.pendingSegments[this.pendingSegments.length - 1];
    if (!segment || segment.isData !== isData) {
      segment = { isData, bytes: new Uint8Array(256), length: 0 };
      this.pendingSegments.push(segment);
    }
    if (segment.length === segment.bytes.length) {
      const bytes = new Uint8Array(segment.bytes.length * 2);
      bytes.set(segment.bytes);
      segment.bytes = bytes;
    }
    segment.bytes[segment.length++] = value & 0xff;
  }

  queueWorkerBytes(isData, bytes) {
    let segment = this.pendingSegments[this.pendingSegments.length - 1];
    if (!segment || segment.isData !== isData) {
      segment = { isData, bytes: new Uint8Array(Math.max(256, bytes.length)), length: 0 };
      this.pendingSegments.push(segment);
    }
    if (segment.length + bytes.length > segment.bytes.length) {
      const capacity = Math.max(segment.bytes.length * 2, segment.length + bytes.length);
      const buffer = new Uint8Array(capacity);
      buffer.set(segment.bytes.subarray(0, segment.length));
      segment.bytes = buffer;
    }
    segment.bytes.set(bytes, segment.length);
    segment.length += bytes.length;
  }

  dispatchWorkerTransaction() {
    const segments = this.pendingSegments.map((segment) => ({
      isData: segment.isData,
      bytes: segment.bytes.slice(0, segment.length),
    }));
    this.pendingSegments.length = 0;
    const transferList = segments.map((segment) => segment.bytes.buffer);
    this.worker.postMessage({ type: 'transaction', segments }, transferList);
  }

  writeCommand(command) {
    this.command = command;
    this.parameters = [];
    if (command === COMMAND_MEMORY_WRITE) {
      this.cursorX = this.columnStart;
      this.cursorY = this.rowStart;
      this.cursorIndex = this.windowStartIndex;
      this.pixelHighByte = null;
      this.writeWindowDirtyMarked = false;
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
      this.configureWindow();
    } else if (this.command === COMMAND_ROW_ADDRESS && this.parameters.length === 4) {
      this.rowStart = (this.parameters[0] << 8) | this.parameters[1];
      this.rowEnd = (this.parameters[2] << 8) | this.parameters[3];
      this.parameters = [];
      this.configureWindow();
    }
  }

  configureWindow() {
    this.columnOffset = this.columnEnd >= this.width ? this.columnStart : 0;
    this.rowOffset = this.rowEnd >= this.height ? this.rowStart : 0;
    this.windowStartX = this.columnStart - this.columnOffset;
    this.windowEndX = this.columnEnd - this.columnOffset;
    this.windowStartY = this.rowStart - this.rowOffset;
    this.windowEndY = this.rowEnd - this.rowOffset;
    this.windowVisible = this.columnStart <= this.columnEnd && this.rowStart <= this.rowEnd &&
      this.windowStartX >= 0 && this.windowStartY >= 0 &&
      this.windowEndX < this.width && this.windowEndY < this.height;
    this.windowStartIndex = this.windowStartY * this.width + this.windowStartX;
    this.windowIndexStep = this.width - (this.columnEnd - this.columnStart + 1);
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
    if (this.windowVisible) {
      const index = this.cursorIndex;
      if (this.pixels[index] !== value) {
        this.pixels[index] = value;
        if (!this.writeWindowDirtyMarked) this.markWriteWindowDirty();
      }
      this.cursorX++;
      this.cursorIndex++;
      if (this.cursorX > this.columnEnd) {
        this.cursorX = this.columnStart;
        this.cursorY++;
        if (this.cursorY > this.rowEnd) {
          this.cursorY = this.rowStart;
          this.cursorIndex = this.windowStartIndex;
        } else {
          this.cursorIndex += this.windowIndexStep;
        }
      }
      return;
    }

    const x = this.cursorX - (this.columnEnd >= this.width ? this.columnStart : 0);
    const y = this.cursorY - (this.rowEnd >= this.height ? this.rowStart : 0);
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      const index = y * this.width + x;
      if (this.pixels[index] !== value) {
        this.pixels[index] = value;
        if (!this.writeWindowDirtyMarked) this.markWriteWindowDirty();
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
    let cursorIndex = this.cursorIndex;
    let highByte = this.pixelHighByte;

    for (const byte of bytes) {
      if (highByte === null) {
        highByte = byte;
        continue;
      }
      const value = (highByte << 8) | byte;
      if (this.windowVisible) {
        if (this.pixels[cursorIndex] !== value) {
          this.pixels[cursorIndex] = value;
          if (!this.writeWindowDirtyMarked) this.markWriteWindowDirty();
        }
      } else {
        const x = cursorX - columnOffset;
        const y = cursorY - rowOffset;
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
          const index = y * this.width + x;
          if (this.pixels[index] !== value) {
            this.pixels[index] = value;
            if (!this.writeWindowDirtyMarked) this.markWriteWindowDirty();
          }
        }
      }
      highByte = null;
      cursorX++;
      cursorIndex++;
      if (cursorX > this.columnEnd) {
        cursorX = this.columnStart;
        cursorY++;
        if (cursorY > this.rowEnd) {
          cursorY = this.rowStart;
          cursorIndex = this.windowStartIndex;
        } else {
          cursorIndex += this.windowIndexStep;
        }
      }
    }

    this.cursorX = cursorX;
    this.cursorY = cursorY;
    this.cursorIndex = cursorIndex;
    this.pixelHighByte = highByte;
  }

  markWriteWindowDirty() {
    this.dirty = true;
    if (this.writeWindowDirtyMarked) return;
    this.writeWindowDirtyMarked = true;
    if (this.fullFrameDirty) return;
    this.markDirtyBounds(
      Math.max(0, this.windowStartX),
      Math.max(0, this.windowStartY),
      Math.min(this.width - 1, this.windowEndX),
      Math.min(this.height - 1, this.windowEndY)
    );
  }

  markDirtyBounds(minX, minY, maxX, maxY) {
    if (this.fullFrameDirty) return;
    if (!this.dirtyBounds) {
      this.dirtyBounds = { minX, minY, maxX, maxY };
      return;
    }
    this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, minX);
    this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, minY);
    this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, maxX);
    this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, maxY);
  }

  flushFrame() {
    if (this.worker) {
      this.dispatchWorkerTransaction();
      return;
    }
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
    const full = x === 0 && y === 0 && frameWidth === this.width && frameHeight === this.height;
    let pixels = source;
    if (!full) {
      pixels = Buffer.allocUnsafe(frameWidth * frameHeight * 2);
      const rowBytes = frameWidth * 2;
      for (let row = 0; row < frameHeight; row++) {
        const sourceStart = ((y + row) * this.width + x) * 2;
        source.copy(pixels, row * rowBytes, sourceStart, sourceStart + rowBytes);
      }
    }
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
    this.writeWindowDirtyMarked = false;
  }

  close() {
    if (this.ownsWorker) return this.worker.terminate();
    return Promise.resolve();
  }
}

module.exports = { ST7789 };

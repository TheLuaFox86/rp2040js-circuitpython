const fs = require('fs');

const SECTOR_SIZE = 512;
const DATA_TOKEN = 0xfe;

function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function crc7(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const feedback = ((crc >> 6) & 1) ^ ((byte >> bit) & 1);
      crc = (crc << 1) & 0x7f;
      if (feedback) crc ^= 0x09;
    }
  }
  return (crc << 1) | 1;
}

function setCsdBits(csd, mostSignificantBit, leastSignificantBit, value) {
  for (let bit = leastSignificantBit; bit <= mostSignificantBit; bit++) {
    const byteIndex = 15 - Math.floor(bit / 8);
    const bitIndex = bit % 8;
    if (Math.floor(value / 2 ** (bit - leastSignificantBit)) % 2) {
      csd[byteIndex] |= 1 << bitIndex;
    }
  }
}

class SDCardImage {
  constructor({ image, chipSelect }) {
    if (!image) throw new Error('SD card config requires an image path');
    this.image = image;
    this.chipSelect = chipSelect;
    this.fd = fs.openSync(image, 'r+');
    let stat;
    try {
      stat = fs.fstatSync(this.fd);
    } catch (error) {
      fs.closeSync(this.fd);
      throw error;
    }
    if (!stat.isFile() || stat.size < SECTOR_SIZE || stat.size % SECTOR_SIZE !== 0) {
      fs.closeSync(this.fd);
      throw new Error(`SD card image must be a non-empty multiple of 512 bytes: ${image}`);
    }

    this.sectorCount = stat.size / SECTOR_SIZE;
    if (this.sectorCount > 0x100000000) {
      fs.closeSync(this.fd);
      throw new RangeError(`SD card image exceeds the SDHC address limit: ${image}`);
    }
    this.highCapacity = this.sectorCount >= 4 * 1024 * 1024;
    this.selected = false;
    this.idle = true;
    this.applicationCommand = false;
    this.command = [];
    this.response = [];
    this.writeState = null;
    this.readState = null;
  }

  setSelected(selected) {
    if (this.selected === selected) return;
    this.selected = selected;
    this.command.length = 0;
    if (!selected) this.response.length = 0;
  }

  transfer(byte) {
    byte &= 0xff;
    if (!this.selected) return 0xff;

    if (this.response.length) return this.response.shift();
    if (this.writeState) return this.receiveWriteByte(byte);

    if (this.readState && this.command.length === 0 && (byte & 0xc0) !== 0x40) {
      this.queueReadBlock();
      return this.response.shift();
    }

    if (this.command.length) {
      this.command.push(byte);
    } else if ((byte & 0xc0) === 0x40) {
      this.command.push(byte);
    } else {
      return 0xff;
    }

    if (this.command.length === 6) {
      const command = this.command;
      this.command = [];
      this.executeCommand(command);
    }
    return 0xff;
  }

  executeCommand(command) {
    const commandNumber = command[0] & 0x3f;
    const argument =
      command[1] * 0x1000000 +
      command[2] * 0x10000 +
      command[3] * 0x100 +
      command[4];
    const idleResponse = this.idle ? 1 : 0;
    const response = (bytes) => this.response.push(...bytes);
    const queueData = (r1, data) => {
      const checksum = crc16(data);
      response([
        r1,
        0xff,
        DATA_TOKEN,
        ...data,
        (checksum >> 8) & 0xff,
        checksum & 0xff,
      ]);
    };

    if ((commandNumber === 0 || commandNumber === 8) &&
      command[5] !== crc7(command.slice(0, 5))) {
      response([idleResponse | 0x08]);
      return;
    }

    switch (commandNumber) {
      case 0:
        this.idle = true;
        this.applicationCommand = false;
        response([1]);
        break;
      case 8:
        response([idleResponse, 0, 0, 1, 0xaa]);
        break;
      case 9:
        queueData(idleResponse, this.getCsd());
        break;
      case 10:
        queueData(idleResponse, this.getCid());
        break;
      case 12:
        this.readState = null;
        this.response.unshift(0xff);
        response([idleResponse]);
        break;
      case 13:
        response([idleResponse, 0]);
        break;
      case 16:
        response([argument === SECTOR_SIZE ? idleResponse : idleResponse | 0x40]);
        break;
      case 17: {
        const sector = this.highCapacity ? argument : Math.floor(argument / SECTOR_SIZE);
        if (sector >= this.sectorCount) {
          response([idleResponse | 0x20]);
          break;
        }
        const data = Buffer.alloc(SECTOR_SIZE);
        const bytesRead = fs.readSync(this.fd, data, 0, SECTOR_SIZE, sector * SECTOR_SIZE);
        if (bytesRead !== SECTOR_SIZE) throw new Error(`Could not read SD card sector ${sector} from ${this.image}`);
        queueData(idleResponse, data);
        break;
      }
      case 18: {
        const sector = this.highCapacity ? argument : Math.floor(argument / SECTOR_SIZE);
        if (sector >= this.sectorCount) {
          response([idleResponse | 0x20]);
          break;
        }
        response([idleResponse]);
        this.readState = { sector };
        break;
      }
      case 24: {
        const sector = this.highCapacity ? argument : Math.floor(argument / SECTOR_SIZE);
        if (sector >= this.sectorCount) {
          response([idleResponse | 0x20]);
          break;
        }
        response([idleResponse]);
        this.writeState = { sector, bytes: [], tokenReceived: false, multi: false };
        break;
      }
      case 25: {
        const sector = this.highCapacity ? argument : Math.floor(argument / SECTOR_SIZE);
        if (sector >= this.sectorCount) {
          response([idleResponse | 0x20]);
          break;
        }
        response([idleResponse]);
        this.writeState = { sector, bytes: [], tokenReceived: false, multi: true };
        break;
      }
      case 55:
        this.applicationCommand = true;
        response([idleResponse]);
        break;
      case 41:
        if (this.applicationCommand) {
          this.applicationCommand = false;
          this.idle = false;
          response([0]);
        } else {
          response([idleResponse | 0x04]);
        }
        break;
      case 58: {
        const ocr = this.highCapacity ? [0xc0, 0xff, 0x80, 0] : [0x80, 0xff, 0x80, 0];
        response([idleResponse, ...ocr]);
        break;
      }
      case 59:
        response([idleResponse]);
        break;
      default:
        response([idleResponse | 0x04]);
        break;
    }
  }

  receiveWriteByte(byte) {
    if (!this.writeState.tokenReceived) {
      if (this.writeState.multi && byte === 0xfd) {
        this.writeState = null;
      } else if (byte === (this.writeState.multi ? 0xfc : DATA_TOKEN)) {
        this.writeState.tokenReceived = true;
      }
      return 0xff;
    }

    this.writeState.bytes.push(byte);
    if (this.writeState.bytes.length < SECTOR_SIZE + 2) return 0xff;

    const { sector, bytes, multi } = this.writeState;
    if (sector >= this.sectorCount) {
      this.response.push(0x0d);
      this.writeState = null;
      return 0xff;
    }
    const block = Buffer.from(bytes.slice(0, SECTOR_SIZE));
    const bytesWritten = fs.writeSync(this.fd, block, 0, block.length, sector * SECTOR_SIZE);
    if (bytesWritten !== block.length) throw new Error(`Could not write SD card sector ${sector} to ${this.image}`);
    this.response.push(0x05, 0x00, 0xff);
    if (multi) {
      this.writeState = { sector: sector + 1, bytes: [], tokenReceived: false, multi: true };
    } else {
      this.writeState = null;
    }
    return 0xff;
  }

  queueReadBlock() {
    const { sector } = this.readState;
    if (sector >= this.sectorCount) {
      this.readState = null;
      this.response.push(0x08);
      return;
    }
    const data = Buffer.alloc(SECTOR_SIZE);
    const bytesRead = fs.readSync(this.fd, data, 0, SECTOR_SIZE, sector * SECTOR_SIZE);
    if (bytesRead !== SECTOR_SIZE) throw new Error(`Could not read SD card sector ${sector} from ${this.image}`);
    const checksum = crc16(data);
    this.response.push(
      0xff,
      DATA_TOKEN,
      ...data,
      (checksum >> 8) & 0xff,
      checksum & 0xff
    );
    this.readState.sector++;
  }

  getCsd() {
    const csd = Buffer.alloc(16);
    if (this.highCapacity) {
      setCsdBits(csd, 127, 126, 1);
      setCsdBits(csd, 83, 80, 9);
      setCsdBits(csd, 69, 48, Math.max(0, Math.ceil(this.sectorCount / 1024) - 1));
    } else {
      let multiplier = 0;
      let size = Math.ceil(this.sectorCount / 4) - 1;
      while (size > 0xfff && multiplier < 7) {
        multiplier++;
        size = Math.ceil(this.sectorCount / 2 ** (multiplier + 2)) - 1;
      }
      setCsdBits(csd, 83, 80, 9);
      setCsdBits(csd, 73, 62, Math.min(size, 0xfff));
      setCsdBits(csd, 49, 47, multiplier);
    }
    csd[15] = crc7(csd.subarray(0, 15));
    return csd;
  }

  getCid() {
    const cid = Buffer.from([
      0x52, 0x50, 0x32, 0x30, 0x34, 0x30, 0x31, 0x00,
      0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01,
    ]);
    cid[15] = crc7(cid.subarray(0, 15));
    return cid;
  }

  close() {
    fs.closeSync(this.fd);
  }
}

module.exports = { SDCardImage };

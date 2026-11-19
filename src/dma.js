const { BasePeripheral } = require('rp2040js');

const CHANNEL_COUNT = 12;
const CHANNEL_STRIDE = 0x40;
const DMA_MULTI_CHAN_TRIGGER = 0x430;
const DMA_SPI0_TX = 16;
const DMA_SPI0_RX = 17;

class DMAPeripheral extends BasePeripheral {
  constructor(rp2040) {
    super(rp2040, 'DMA');
    this.channels = Array.from({ length: CHANNEL_COUNT }, () => ({
      readAddress: 0,
      writeAddress: 0,
      count: 0,
      control: 0,
    }));
  }

  readUint32(offset) {
    if (offset >= DMA_MULTI_CHAN_TRIGGER) return 0;
    const channelIndex = Math.floor(offset / CHANNEL_STRIDE);
    const register = offset % CHANNEL_STRIDE;
    const channel = this.channels[channelIndex];
    if (!channel) return super.readUint32(offset);

    switch (register) {
      case 0x00: return channel.readAddress;
      case 0x04: return channel.writeAddress;
      case 0x08: return channel.count;
      case 0x0c: return channel.control;
      case 0x10: return channel.control;
      case 0x14: return channel.readAddress;
      case 0x18: return channel.writeAddress;
      case 0x20: return channel.control;
      case 0x24: return channel.count;
      case 0x28: return channel.readAddress;
      case 0x2c: return channel.writeAddress;
      case 0x30: return channel.control;
      case 0x34: return channel.writeAddress;
      case 0x38: return channel.count;
      case 0x3c: return channel.readAddress;
      default: return 0;
    }
  }

  writeUint32(offset, value) {
    if (offset === DMA_MULTI_CHAN_TRIGGER) {
      this.startChannels(value);
      return;
    }
    const channelIndex = Math.floor(offset / CHANNEL_STRIDE);
    const register = offset % CHANNEL_STRIDE;
    const channel = this.channels[channelIndex];
    if (!channel) {
      super.writeUint32(offset, value);
      return;
    }

    switch (register) {
      case 0x00: channel.readAddress = value >>> 0; break;
      case 0x04: channel.writeAddress = value >>> 0; break;
      case 0x08: channel.count = value >>> 0; break;
      case 0x0c:
        channel.control = value >>> 0;
        if (channel.control & 1) this.startChannels(1 << channelIndex);
        break;
      case 0x10: channel.control = value >>> 0; break;
      case 0x14: channel.readAddress = value >>> 0; break;
      case 0x18: channel.writeAddress = value >>> 0; break;
      case 0x1c:
        channel.count = value >>> 0;
        this.startChannels(1 << channelIndex);
        break;
      case 0x20: channel.control = value >>> 0; break;
      case 0x24: channel.count = value >>> 0; break;
      case 0x28: channel.readAddress = value >>> 0; break;
      case 0x2c:
        channel.writeAddress = value >>> 0;
        this.startChannels(1 << channelIndex);
        break;
      case 0x30: channel.control = value >>> 0; break;
      case 0x34: channel.writeAddress = value >>> 0; break;
      case 0x38: channel.count = value >>> 0; break;
      case 0x3c:
        channel.readAddress = value >>> 0;
        this.startChannels(1 << channelIndex);
        break;
    }
  }

  startChannels(mask) {
    const selected = [];
    for (let index = 0; index < this.channels.length; index++) {
      if (mask & (1 << index)) {
        selected.push(index);
        this.channels[index].control |= 1 | (1 << 24);
      }
    }
    const tx = selected.find((index) => this.dreq(this.channels[index]) === DMA_SPI0_TX);
    const rx = selected.find((index) => this.dreq(this.channels[index]) === DMA_SPI0_RX);
    if (tx !== undefined) {
      this.transferSPI(tx, rx);
    } else if (rx !== undefined) {
      this.transferSPI(undefined, rx);
    } else {
      for (const index of selected) this.transferMemory(index);
    }
    for (const index of selected) {
      this.channels[index].control &= ~(1 << 24);
    }
  }

  dreq(channel) {
    return (channel.control >>> 15) & 0x3f;
  }

  transferSPI(txIndex, rxIndex) {
    const tx = txIndex === undefined ? null : this.channels[txIndex];
    const rx = rxIndex === undefined ? null : this.channels[rxIndex];
    const count = tx && rx ? Math.min(tx.count, rx.count) : (tx?.count ?? rx?.count ?? 0);
    if (tx && rx && this.transferSPIBuffer(tx, rx, count)) return;
    for (let index = 0; index < count; index++) {
      let received = 0xff;
      if (tx) {
        const value = this.readTransferValue(tx);
        this.writeTransferValue(tx.writeAddress, value, tx.control);
        if (rx) received = this.readTransferValue(rx);
      } else if (rx) {
        this.writeTransferValue(rx.readAddress, 0xff, rx.control);
        received = this.readTransferValue(rx);
      }
      if (rx) this.writeTransferValue(rx.writeAddress, received, rx.control);
      if (tx) this.advance(tx, true, false);
      if (rx) this.advance(rx, false, true);
    }
    if (tx) tx.count = 0;
    if (rx) rx.count = 0;
  }

  transferSPIBuffer(tx, rx, count) {
    if (count === 0 || ((tx.control >>> 2) & 0x3) !== 0 ||
      ((rx.control >>> 2) & 0x3) !== 0 || !(tx.control & (1 << 4)) ||
      (tx.control & (1 << 5)) || (rx.control & (1 << 4)) ||
      tx.writeAddress !== rx.readAddress) return false;

    const offset = tx.writeAddress & 0x3fff;
    const peripheralKey = (tx.writeAddress >>> 14) << 2;
    const spi = this.rp2040.peripherals[peripheralKey];
    if (offset !== 0x08 || !spi || typeof spi.canTransferBuffer !== 'function' ||
      !spi.canTransferBuffer()) return false;

    const bytes = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
      bytes[index] = this.rp2040.readUint8(tx.readAddress + index);
    }
    const received = spi.transferBuffer(bytes);
    if (!received || received.length !== count) return false;

    if (rx.control & (1 << 5)) {
      for (let index = 0; index < count; index++) {
        this.rp2040.writeUint8(rx.writeAddress + index, received[index]);
      }
      rx.writeAddress += count;
    } else {
      this.rp2040.writeUint8(rx.writeAddress, received[count - 1]);
    }
    tx.readAddress += count;
    tx.count = 0;
    rx.count = 0;
    return true;
  }

  transferMemory(index) {
    const channel = this.channels[index];
    for (let count = 0; count < channel.count; count++) {
      const value = this.readTransferValue(channel);
      this.writeTransferValue(channel.writeAddress, value, channel.control);
      this.advance(channel, true, true);
    }
    channel.count = 0;
  }

  readTransferValue(channel) {
    const size = 1 << ((channel.control >>> 2) & 0x3);
    if (size === 1) return this.rp2040.readUint8(channel.readAddress);
    if (size === 2) return this.rp2040.readUint16(channel.readAddress);
    return this.rp2040.readUint32(channel.readAddress);
  }

  writeTransferValue(address, value, control) {
    const size = 1 << ((control >>> 2) & 0x3);
    if (size === 1) this.rp2040.writeUint8(address, value);
    else if (size === 2) this.rp2040.writeUint16(address, value);
    else this.rp2040.writeUint32(address, value);
  }

  advance(channel, incrementRead, incrementWrite) {
    const size = 1 << ((channel.control >>> 2) & 0x3);
    if (incrementRead && (channel.control & (1 << 4))) channel.readAddress += size;
    if (incrementWrite && (channel.control & (1 << 5))) channel.writeAddress += size;
  }
}

module.exports = { DMAPeripheral };

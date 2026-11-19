const CARDKB_ADDRESS = 0x5f;
const MAX_BUFFERED_KEYS = 256;

class CardKB {
  constructor(i2c, address = CARDKB_ADDRESS) {
    this.address = address;
    this.keys = [];
    this.active = false;

    const onStart = i2c.onStart;
    const onConnect = i2c.onConnect;
    const onWriteByte = i2c.onWriteByte;
    const onReadByte = i2c.onReadByte;
    const onStop = i2c.onStop;

    i2c.onStart = (...args) => onStart(...args);
    i2c.onConnect = (targetAddress, mode) => {
      if (targetAddress !== this.address) {
        onConnect(targetAddress, mode);
        return;
      }
      this.active = true;
      i2c.completeConnect(true);
    };
    i2c.onWriteByte = (value) => {
      if (!this.active) {
        onWriteByte(value);
        return;
      }
      i2c.completeWrite(true);
    };
    i2c.onReadByte = () => {
      if (!this.active) {
        onReadByte();
        return;
      }
      i2c.completeRead(this.keys.shift() ?? 0);
    };
    i2c.onStop = () => {
      this.active = false;
      onStop();
    };
    this.i2c = i2c;
  }

  pressKey(value) {
    if (typeof value !== 'string' || Array.from(value).length !== 1) {
      throw new TypeError('CardKB key must be a single character');
    }
    const byte = value.codePointAt(0);
    if (byte > 0xff) throw new RangeError('CardKB keys must fit in one byte');
    if (this.keys.length >= MAX_BUFFERED_KEYS) {
      throw new RangeError('CardKB key buffer is full');
    }
    this.keys.push(byte);
  }
}

module.exports = { CARDKB_ADDRESS, CardKB };

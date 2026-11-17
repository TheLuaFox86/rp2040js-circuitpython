const { GPIOPinState } = require('rp2040js');

function createGPIOApi(rp2040, onChange = () => {}) {
  if (typeof onChange !== 'function') {
    throw new TypeError('GPIO change handler must be a function');
  }
  const inputListeners = new Map();
  for (const pin of rp2040.gpio) pin.checkForUpdates();

  function getPin(pinNumber) {
    if (!Number.isInteger(pinNumber) || pinNumber < 0 || pinNumber >= rp2040.gpio.length) {
      throw new RangeError(`GPIO pin must be an integer from 0 to ${rp2040.gpio.length - 1}`);
    }
    return rp2040.gpio[pinNumber];
  }

  const api = {
    read(pinNumber) {
      const pin = getPin(pinNumber);
      return {
        state: pin.value,
        input: pin.inputValue,
        output: pin.outputValue,
        outputEnabled: pin.outputEnable,
        functionSelect: pin.functionSelect,
      };
    },
    setInput(pinNumber, value) {
      if (typeof value !== 'boolean') {
        throw new TypeError('GPIO input value must be a boolean');
      }
      const pin = getPin(pinNumber);
      const previousInput = pin.inputValue;
      if (previousInput === value) return;
      pin.setInputValue(value);
      pin.checkForUpdates();
      const state = pin.value;
      onChange(pinNumber, state, state, value, previousInput);
      for (const callback of inputListeners.get(pinNumber) || []) {
        callback(state, state, value, previousInput);
      }
    },
    onChange(pinNumber, callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('GPIO change listener must be a function');
      }
      const pin = getPin(pinNumber);
      const removeStateListener = pin.addListener((state, previousState) => {
        callback(state, previousState, pin.inputValue, pin.inputValue);
      });
      let listeners = inputListeners.get(pinNumber);
      if (!listeners) {
        listeners = new Set();
        inputListeners.set(pinNumber, listeners);
      }
      listeners.add(callback);
      return () => {
        removeStateListener();
        listeners.delete(callback);
      };
    },
    states: GPIOPinState,
  };

  for (const pin of rp2040.gpio) {
    pin.addListener((state, previousState) => {
      onChange(pin.index, state, previousState, pin.inputValue, pin.inputValue);
    });
  }

  return api;
}

module.exports = { createGPIOApi };

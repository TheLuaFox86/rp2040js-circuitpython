# CircuitPython Command-line Simulator

A simple CircuitPython on Raspberry Pi Pico simulator, built on top of the [rp2040js](https://github.com/wokwi/rp2040js) library.

You can use this simulator to run the release firmware of CircuitPython on your computer, even if you
don't have access to the physical hardware. You can use it for automated testing (e.g. in a CI environment), as well as for educational purposes.
The bundled `firmware/firm.uf2` is the stable CircuitPython 7.3.3 build for Raspberry Pi Pico.

If you are looking for a full-blown, user friendly CircuitPython simulator, please check out [Wokwi](https://wokwi.com): Start a [new CircuitPython project on Wokwi](https://wokwi.com/arduino/new?template=circuitpython-pi-pico).

## Usage

You'll need [Node.js](https://nodejs.org/en/download/) and npm (which comes bundled with Node.js). Clone this repo, and then:

```
npm install
npm start
```

The simulator prints the TCP console address in the launcher. Connect PuTTY using:

- Connection type: **Telnet**
- Host name: `127.0.0.1`
- Port: `3232`

The console carries CircuitPython's USB serial output and keyboard input. It buffers startup output until the client connects, and the emulated USB host services CDC output even when no keyboard input is sent. Press Enter at the initial prompt to enter the REPL; use Ctrl+D to soft-restart CircuitPython and Ctrl+E to enter paste mode. Stop the simulator with Ctrl+C in the launcher.

The TCP console binds to `127.0.0.1` by default. Set `SERIAL_PORT` to change its port. To accept connections from another computer, set `SERIAL_HOST=0.0.0.0` and connect to this computer's LAN address. The TCP console has no authentication, so only expose it on a trusted network.

## GPIO and SPI SD cards

The board setup is kept in `BOARD_CONFIG` in `src/index.js`. The emulated Pico runs whether or not PuTTY is connected, and CPU execution is paced against the configured `clockHz` (125 MHz by default). rp2040js currently waits in its ROM model before the XIP handoff, so `firmwareEntryPoint` defaults to the UF2 flash start (`0x10000000`); set it to `undefined` to try the modeled ROM path.

The returned simulator API exposes GPIO inputs and state:

```js
const { createSimulator, BOARD_CONFIG } = require('.');
const simulator = createSimulator(BOARD_CONFIG);
simulator.start();
simulator.gpio.setInput(2, true);
console.log(simulator.gpio.read(2));
simulator.gpio.onChange(25, (state, previousState) => {
  console.log('GP25 changed:', previousState, '->', state);
});
```

`setInput` drives an external input into a pin. `read` reports its input/output state, and `onChange` subscribes to state changes. Its callback receives `(state, previousState, input, previousInput)`.

One SPI0 bus can host multiple image-backed SD cards, each with a separate chip-select GPIO. For example, edit `BOARD_CONFIG.spi.cards`:

```js
cards: [
  { image: 'sdcard0.img', chipSelect: 17 },
  { image: 'sdcard1.img', chipSelect: 20 },
]
```

The default SPI0 pins are GP18 (SCK), GP19 (MOSI), and GP16 (MISO). Create and populate the images with standard Linux FAT and mtools utilities before starting the simulator:

```sh
truncate -s 64M sdcard0.img
mkfs.vfat sdcard0.img
mcopy -i sdcard0.img code.py ::/code.py
```

Repeat for each card image. Images are writable and changes are persisted directly to their sectors. The emulator does not format images automatically.

## GDB Server

The simulator listens for GDB connections on port 3333. Use the following command to connect the GDB debugger to the simulator:

```
target remote localhost:3333
```

You can change the port number by setting the `GDB_PORT` environment variable.

## License

Copyright (C) 2021 Uri Shaked. Released under the MIT license.

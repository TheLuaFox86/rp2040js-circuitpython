# CircuitPython Command-line Simulator

A simple CircuitPython on Raspberry Pi Pico simulator, built on top of the [rp2040js](https://github.com/wokwi/rp2040js) library.

You can use this simulator to run the release firmware of CircuitPython on your computer, even if you
don't have access to the physical hardware. You can use it for automated testing (e.g. in a CI environment), as well as for educational purposes.

If you are looking for a full-blown, user friendly CircuitPython simulator, please check out [Wokwi](https://wokwi.com): Start a [new CircuitPython project on Wokwi](https://wokwi.com/arduino/new?template=circuitpython-pi-pico).

## Usage

You'll need [Node.js](https://nodejs.org/en/download/) and npm (which comes bundled with Node.js). Clone this repo, and then:

```
npm install
npm start
```

The simulator prints the TCP console address in the launcher. Connect PuTTY using:

- Connection type: **Raw**
- Host name: `127.0.0.1`
- Port: `2323`

The console carries CircuitPython's USB serial output and keyboard input. It buffers startup output until the client connects. Press Enter at the initial prompt to enter the REPL; use Ctrl+D to soft-restart CircuitPython and Ctrl+E to enter paste mode. Stop the simulator with Ctrl+C in the launcher.

The TCP console binds to `127.0.0.1` by default. Set `SERIAL_PORT` to change its port. To accept connections from another computer, set `SERIAL_HOST=0.0.0.0` and connect to this computer's LAN address. The TCP console has no authentication, so only expose it on a trusted network.

## GDB Server

The simulator listens for GDB connections on port 3333. Use the following command to connect the GDB debugger to the simulator:

```
target remote localhost:3333
```

You can change the port number by setting the `GDB_PORT` environment variable.

## License

Copyright (C) 2021 Uri Shaked. Released under the MIT license.

const net = require('net');

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const TELNET_ECHO = 1;
const TELNET_SUPPRESS_GO_AHEAD = 3;

function startTcpConsole({ host, port, onSerialBytes }) {
  let client = null;
  let bufferedOutput = [];
  let bufferedOutputBytes = 0;
  let previousByteWasCR = false;
  let telnetState = 'data';
  let telnetOption = null;
  let closeRequested = false;

  function writeRawToSocket(socket, bytes) {
    const output = Buffer.allocUnsafe(bytes.length * 2);
    let length = 0;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (byte === IAC) {
        output[length++] = IAC;
        output[length++] = IAC;
      } else if (byte === 13) {
        output[length++] = 13;
        if (bytes[index + 1] === 10) {
          output[length++] = 10;
          index++;
        } else {
          output[length++] = 0;
        }
      } else if (byte === 10) {
        output[length++] = 13;
        output[length++] = 10;
      } else {
        output[length++] = byte;
      }
    }
    socket.write(output.subarray(0, length));
  }

  function telnetReply(socket, command, option) {
    socket.write(Buffer.from([IAC, command, option]));
  }

  const server = net.createServer((socket) => {
    if (client) {
      socket.end('A serial console client is already connected.\r\n');
      return;
    }

    client = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true);

    telnetReply(socket, WILL, TELNET_ECHO);
    telnetReply(socket, WILL, TELNET_SUPPRESS_GO_AHEAD);

    socket.on('data', (chunk) => {
      const serialBytes = [];
      for (const byte of chunk) {
        if (telnetState === 'subnegotiation') {
          if (byte === IAC) telnetState = 'subnegotiation-iac';
          continue;
        }
        if (telnetState === 'subnegotiation-iac') {
          telnetState = byte === SE ? 'data' : 'subnegotiation';
          continue;
        }
        if (telnetState === 'iac') {
          telnetState = 'data';
          if (byte === IAC) {
            serialBytes.push(IAC);
          } else if (byte === DO || byte === DONT || byte === WILL || byte === WONT) {
            telnetState = 'option';
            telnetOption = byte;
          } else if (byte === SB) {
            telnetState = 'subnegotiation';
          }
          continue;
        }
        if (telnetState === 'option') {
          if (telnetOption === DO) {
            if (byte === TELNET_ECHO || byte === TELNET_SUPPRESS_GO_AHEAD) {
              telnetReply(socket, WILL, byte);
            } else {
              telnetReply(socket, WONT, byte);
            }
          } else if (telnetOption === DONT) {
            telnetReply(socket, WONT, byte);
          } else if (telnetOption === WILL) {
            telnetReply(socket, byte === TELNET_SUPPRESS_GO_AHEAD ? DO : DONT, byte);
          } else if (telnetOption === WONT) {
            telnetReply(socket, DONT, byte);
          }
          telnetState = 'data';
          telnetOption = null;
          continue;
        }
        if (byte === IAC) {
          telnetState = 'iac';
        } else if (byte === 13) {
          serialBytes.push(13);
          previousByteWasCR = true;
        } else if (byte === 10) {
          if (!previousByteWasCR) serialBytes.push(13);
          previousByteWasCR = false;
        } else if (byte === 0) {
          if (!previousByteWasCR) serialBytes.push(0);
          previousByteWasCR = false;
        } else {
          serialBytes.push(byte);
          previousByteWasCR = false;
        }
      }
      if (serialBytes.length) onSerialBytes(Buffer.from(serialBytes));
    });
    socket.on('close', () => {
      if (client === socket) client = null;
      previousByteWasCR = false;
      telnetState = 'data';
      telnetOption = null;
    });
    socket.on('error', (error) => {
      console.error(`TCP serial client error: ${error.message}`);
      if (client === socket) client = null;
      previousByteWasCR = false;
      telnetState = 'data';
      telnetOption = null;
    });

    if (bufferedOutputBytes) {
      for (const chunk of bufferedOutput) writeRawToSocket(socket, chunk);
      bufferedOutput = [];
      bufferedOutputBytes = 0;
    }
  });

  server.on('error', (error) => {
    console.error(`TCP serial server error: ${error.message}`);
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.error(`PuTTY serial console: ${host}:${address.port} (Telnet)`);
    if (closeRequested) server.close();
  });

  return {
    write(bytes) {
      if (client && !client.destroyed) {
        writeRawToSocket(client, bytes);
        return;
      }
      const chunk = Buffer.from(bytes);
      bufferedOutput.push(chunk);
      bufferedOutputBytes += chunk.length;
    },
    close() {
      closeRequested = true;
      if (client) client.destroy();
      if (server.listening) server.close();
    },
    server,
  };
}

module.exports = { startTcpConsole };

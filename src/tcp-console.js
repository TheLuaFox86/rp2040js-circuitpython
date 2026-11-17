const net = require('net');

const MAX_BUFFERED_OUTPUT = 64 * 1024;

function startTcpConsole({ host, port, onSerialBytes }) {
  let client = null;
  let bufferedOutput = Buffer.alloc(0);
  let previousByteWasCR = false;

  const server = net.createServer((socket) => {
    if (client) {
      socket.end('A serial console client is already connected.\r\n');
      return;
    }

    client = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      const serialBytes = [];
      for (const byte of chunk) {
        if (byte === 13) {
          serialBytes.push(13);
          previousByteWasCR = true;
        } else if (byte === 10) {
          if (!previousByteWasCR) serialBytes.push(13);
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
    });
    socket.on('error', (error) => {
      console.error(`TCP serial client error: ${error.message}`);
      if (client === socket) client = null;
      previousByteWasCR = false;
    });

    if (bufferedOutput.length) {
      socket.write(bufferedOutput);
      bufferedOutput = Buffer.alloc(0);
    }
  });

  server.on('error', (error) => {
    console.error(`TCP serial server error: ${error.message}`);
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.error(`PuTTY serial console: ${host}:${address.port} (Raw TCP)`);
  });

  return {
    write(bytes) {
      if (client && !client.destroyed) {
        client.write(bytes);
        return;
      }
      bufferedOutput = Buffer.concat([bufferedOutput, bytes]);
      if (bufferedOutput.length > MAX_BUFFERED_OUTPUT) {
        bufferedOutput = bufferedOutput.subarray(-MAX_BUFFERED_OUTPUT);
      }
    },
    server = server
  };
}

module.exports = { startTcpConsole };

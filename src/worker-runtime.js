const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { startTcpConsole } = require('./tcp-console');
const { startWebUI } = require('./web-ui');

function startWorkerRuntime(config) {
  let worker;
  let webUI;
  let closed = false;

  const serial = startTcpConsole({
    ...config.serial,
    onSerialBytes(bytes) {
      if (!worker) return;
      const input = Uint8Array.from(bytes);
      worker.postMessage({ type: 'serial-input', bytes: input }, [input.buffer]);
    },
  });

  if (config.web?.enabled === true) {
    webUI = startWebUI({
      host: config.web.host || '127.0.0.1',
      port: config.web.port ?? 8080,
      tftEnabled: !!config.tft?.enabled,
      cardkbEnabled: !!config.cardkb?.enabled,
      onKey(key) {
        worker?.postMessage({ type: 'key', key });
      },
      getFrame() {
        return webUI?.getFrame();
      },
    });
  }

  worker = new Worker(path.join(__dirname, 'simulator-worker.js'));
  worker.on('message', (message) => {
    if (message.type === 'serial-output') serial.write(message.bytes);
    else if (message.type === 'frame') webUI?.publishFrame(message.frame);
  });
  worker.on('error', (error) => {
    console.error(`Simulator worker error: ${error.message}`);
  });
  worker.on('exit', (code) => {
    if (!closed && code !== 0) console.error(`Simulator worker exited with code ${code}`);
  });

  return {
    stop() {
      if (closed) return;
      closed = true;
      serial.close();
      webUI?.close();
      worker.postMessage({ type: 'stop' });
      const terminateTimer = setTimeout(() => worker.terminate(), 1000);
      terminateTimer.unref();
      worker.once('exit', () => clearTimeout(terminateTimer));
    },
    worker,
    get servers() {
      return { serial: serial.server, web: webUI?.server };
    },
  };
}

module.exports = { startWorkerRuntime };

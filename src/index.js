const { createSimulator } = require('./simulator');
const fs = require("node:fs")
const BOARD_CONFIG = JSON.parse(fs.readFileSync("./Board.json"))

if (require.main === module) {
  const { startWorkerRuntime } = require('./worker-runtime');
  const simulator = startWorkerRuntime(BOARD_CONFIG);
  process.on('SIGINT', () => simulator.stop());
}

module.exports = { BOARD_CONFIG, createSimulator };

#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const [cmd, ...args] = process.argv.slice(2);

const commands = {
  demo: `node --no-warnings "${path.join(root, 'src/index.js')}"`,
  mount: `mkdir -p ${path.join(root, 'mnt_dir')} && sudo mount -o loop,uid=$(id -u),gid=$(id -g) "${args[0]}" ${path.join(root, 'mnt_dir')} && echo 'use rp2040js-circuitpython unmount to safely unmount the filesystem'`,
  unmount: `sudo umount ${path.join(root, 'mnt_dir')}`,
  test: 'npm test',
};

if (cmd && commands[cmd]) {
  process.exit(execSync(commands[cmd], { stdio: 'inherit', cwd: root }).status);
}

// default: run the actual program
process.exit(execSync(`node --no-warnings "${path.join(root, 'src/index.js')}" ${args.join(' ')}`, { stdio: 'inherit', cwd: root }).status);   
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const androidDir = path.resolve(process.cwd(), 'android');
const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const args = ['--no-daemon', ...process.argv.slice(2)];
const command = process.platform === 'win32' ? 'cmd.exe' : wrapper;
const commandArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', wrapper, ...args]
  : args;

const child = spawn(command, commandArgs, {
  cwd: androidDir,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

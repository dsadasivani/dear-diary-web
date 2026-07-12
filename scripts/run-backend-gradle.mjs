import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = process.cwd();
const backendDir = path.resolve(repositoryRoot, 'backend', 'sync-api');
const wrapper = path.resolve(repositoryRoot, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const args = ['--no-daemon', '-p', backendDir, ...process.argv.slice(2)];
const command = process.platform === 'win32' ? 'cmd.exe' : wrapper;
const commandArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', wrapper, ...args]
  : args;

const child = spawn(command, commandArgs, {
  cwd: repositoryRoot,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

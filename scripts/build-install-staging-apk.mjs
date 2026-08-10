import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const appId = 'com.deardiary.app';
const projectRoot = process.cwd();
const apkPath = path.resolve(
  projectRoot,
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);
const bootTimeoutMs = 240_000;

function parseArguments(args) {
  const options = { avd: process.env.ANDROID_AVD_NAME?.trim() || undefined };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--avd') {
      options.avd = args[index + 1]?.trim();
      if (!options.avd) throw new Error('--avd requires an emulator name.');
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function findAndroidTool(name) {
  const executable = executableName(name);
  const sdkRoots = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
      : undefined,
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Android', 'sdk')
      : undefined,
    process.platform === 'linux' ? path.join(os.homedir(), 'Android', 'Sdk') : undefined,
  ].filter(Boolean);

  for (const sdkRoot of sdkRoots) {
    const candidate = path.join(
      sdkRoot,
      name === 'adb' ? 'platform-tools' : 'emulator',
      executable,
    );
    if (existsSync(candidate)) return candidate;
  }

  return name;
}

function run(command, args, { capture = false, allowFailure = false, cwd = projectRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
    }

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 || allowFailure) {
        resolve({ code: code ?? 1, signal, stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }

      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
      reject(
        new Error(
          `${path.basename(command)} ${args.join(' ')} failed${code === null ? ` (${signal})` : ` with exit code ${code}`}${detail ? `:\n${detail}` : ''}`,
        ),
      );
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listEmulators(adb) {
  const result = await run(adb, ['devices'], { capture: true });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(emulator-\d+)\s+(\S+)/))
    .filter(Boolean)
    .map((match) => ({ serial: match[1], state: match[2] }));
}

async function waitForEmulator(adb, previousSerials, deadline) {
  while (Date.now() < deadline) {
    const emulators = await listEmulators(adb);
    const ready = emulators.find(
      ({ serial, state }) => state === 'device' && !previousSerials.has(serial),
    );
    if (ready) return ready.serial;

    const starting = emulators.find(({ serial }) => !previousSerials.has(serial));
    if (starting?.serial) return starting.serial;
    await sleep(2_000);
  }

  throw new Error('Timed out waiting for the Android emulator to appear in adb.');
}

async function waitForBoot(adb, serial, deadline) {
  process.stdout.write(`Waiting for ${serial} to finish booting`);
  while (Date.now() < deadline) {
    const result = await run(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
      capture: true,
      allowFailure: true,
    });
    if (result.code === 0 && result.stdout.trim() === '1') {
      process.stdout.write(' ready.\n');
      return;
    }
    process.stdout.write('.');
    await sleep(2_000);
  }
  process.stdout.write('\n');
  throw new Error(`Timed out waiting for ${serial} to finish booting.`);
}

async function ensureEmulator(adb, emulator, requestedAvd) {
  const existing = await listEmulators(adb);
  const selectedSerial = process.env.ANDROID_SERIAL?.trim();
  const selected = selectedSerial
    ? existing.find(({ serial }) => serial === selectedSerial)
    : (existing.find(({ state }) => state === 'device') ?? existing[0]);

  if (selected) {
    console.log(`Using Android emulator ${selected.serial}.`);
    await waitForBoot(adb, selected.serial, Date.now() + bootTimeoutMs);
    return selected.serial;
  }

  const avdResult = await run(emulator, ['-list-avds'], { capture: true });
  const avds = avdResult.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (avds.length === 0) {
    throw new Error('No Android emulator is running and no configured AVD was found.');
  }

  const avd = requestedAvd ?? avds[0];
  if (!avds.includes(avd)) {
    throw new Error(`Android AVD "${avd}" was not found. Available AVDs: ${avds.join(', ')}`);
  }

  console.log(`Starting Android emulator AVD "${avd}"...`);
  const child = spawn(emulator, ['-avd', avd], {
    detached: true,
    env: process.env,
    shell: false,
    stdio: 'ignore',
  });
  child.unref();

  const previousSerials = new Set(existing.map(({ serial }) => serial));
  const deadline = Date.now() + bootTimeoutMs;
  const serial = await waitForEmulator(adb, previousSerials, deadline);
  await waitForBoot(adb, serial, deadline);
  return serial;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: npm run android:apk:staging:install -- [--avd <name>]

Builds a debug-signed APK with staging configuration, starts an emulator when
needed, uninstalls ${appId}, and installs the generated APK.

ANDROID_AVD_NAME may also select the AVD. ANDROID_SERIAL may select an already
running emulator.`);
    return;
  }

  const adb = findAndroidTool('adb');
  const emulator = findAndroidTool('emulator');
  const serial = await ensureEmulator(adb, emulator, options.avd);
  const npmCommand = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const npmArgs =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd', 'run', 'mobile:sync:staging']
      : ['run', 'mobile:sync:staging'];

  console.log('\nBuilding and syncing staging assets...');
  await run(npmCommand, npmArgs);

  console.log('\nBuilding the debug-signed Android APK...');
  await run(process.execPath, ['scripts/run-gradle.mjs', 'assembleDebug']);
  if (!existsSync(apkPath))
    throw new Error(`Gradle completed but the APK was not found: ${apkPath}`);

  const installed = await run(adb, ['-s', serial, 'shell', 'pm', 'path', appId], {
    capture: true,
    allowFailure: true,
  });
  if (installed.code === 0 && installed.stdout.startsWith('package:')) {
    console.log(`\nUninstalling ${appId} from ${serial}...`);
    await run(adb, ['-s', serial, 'uninstall', appId]);
  } else {
    console.log(`\n${appId} is not currently installed on ${serial}; skipping uninstall.`);
  }

  console.log(`Installing staging APK on ${serial}...`);
  await run(adb, ['-s', serial, 'install', apkPath]);

  console.log('\nStaging APK installed successfully.');
  console.log(`APK: ${apkPath}`);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  if (existsSync(apkPath)) console.error(`APK: ${apkPath}`);
  process.exitCode = 1;
});

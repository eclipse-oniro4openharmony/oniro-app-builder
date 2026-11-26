import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A stand-in for Huawei's `Emulator` 26.0.0.400 (POSIX shell), replaying its output:
 * `-list -details` and `-imageList` print `<state>/devices.json` / `images.json`
 * (`images-downloaded.json` with `-downloaded true`), or the emulator's "nothing" lines.
 * Every call is appended to `<state>/calls.log`. Licence acceptance is read from and
 * written to `$HOME/Library/Caches/Huawei/Emulator26.0/.emu_config`, as the real one does.
 *
 * `-install` downloads (prints progress, then copies `images-after-install.json` over
 * `images-downloaded.json`) only with the SDK agreement accepted; otherwise it prompts
 * and exits 0, like the real one. `-start` records its environment's
 * `__GL_SYNC_TO_VBLANK` in `<state>/vsync` and then runs until killed, or exits 1 when
 * `<state>/start-fails` exists. `-create`, `-delete` and `-stop` copy
 * `devices-after-<verb>.json` over `devices.json` when present.
 */
export interface FakeHarmonyOsEmulator {
  /** The install: `<root>/emulator/Emulator` (`Emulator.exe` on Windows). */
  root: string;
  binary: string;
  dir: string;
  state: string;
  /** The environment the fake needs: HOME (where licences are recorded) and FAKE_EMU_STATE. */
  env: NodeJS.ProcessEnv;
  home: string;
  calls(): string[];
  write(file: string, value: unknown): void;
  accept(...agreements: string[]): void;
}

export const SDK_AGREEMENT = 'HarmonyOS_SDK_Agreement';
export const SERVICE_AGREEMENT = 'HarmonyOS_Software_Service_Agreement';

const SCRIPT = `#!/bin/sh
S="$FAKE_EMU_STATE"
CFG="$HOME/Library/Caches/Huawei/Emulator26.0/.emu_config"
echo "$*" >> "$S/calls.log"
copy_after() { [ -f "$S/devices-after-$1.json" ] && cp "$S/devices-after-$1.json" "$S/devices.json"; return 0; }
case "$1" in
  -list)
    if [ -f "$S/devices.json" ]; then cat "$S/devices.json"; else echo "[Empty]"; fi ;;
  -imageList)
    f="$S/images.json"
    case "$*" in *-downloaded*) f="$S/images-downloaded.json" ;; esac
    if [ -f "$f" ]; then cat "$f"; else echo "No images matching the criteria were found."; fi ;;
  -install)
    if grep -q "^${SDK_AGREEMENT}:agree" "$CFG" 2>/dev/null; then
      printf '12.5%% (262144/2097152 bytes)\\r50.0%% (1048576/2097152 bytes)\\r'
      printf '100.0%% (2097152/2097152 bytes)\\nThe image is downloaded successfully.\\n'
      if [ -f "$S/images-after-install.json" ]; then cp "$S/images-after-install.json" "$S/images-downloaded.json"; fi
    else
      echo "HarmonyOS SDK License Agreement"
      printf 'Please read carefully and confirm whether agree to the above agreement? (y/N): Please agree to the agreement first.\\n'
    fi ;;
  -create)
    echo "The hotBoot parameter is not set, the default startup mode is cold boot."
    echo "Device create success. You can use the '-start' command to start it."
    copy_after create ;;
  -delete)
    echo "Device delete success."; copy_after delete ;;
  -stop)
    echo "Stop emulator $2 successfully"; copy_after stop ;;
  -start)
    echo "\${__GL_SYNC_TO_VBLANK-unset}" > "$S/vsync"
    if [ -f "$S/start-fails" ]; then echo "KVM is supported and accessible"; echo "Unable to start the emulator"; exit 1; fi
    echo "KVM is supported and accessible"
    trap 'exit 0' TERM INT
    while :; do sleep 1; done ;;
  -license)
    if [ "$2" = "accept" ]; then
      mkdir -p "$(dirname "$CFG")"
      printf '${SDK_AGREEMENT}:agree\\n${SERVICE_AGREEMENT}:agree\\n' > "$CFG"
      echo "All licenses have been automatically accepted."
    else
      echo "There are 2 license agreements that need to be reviewed."
      printf 'Do you want to continue? (y/N): License check aborted by user.\\n'
    fi ;;
  *) echo "unknown command $1"; exit 2 ;;
esac
`;

/** Install the fake under `root` (`<root>/emulator/`), with its state and HOME beside it. */
export function makeFakeHarmonyOsEmulator(root: string): FakeHarmonyOsEmulator {
  const dir = path.join(root, 'emulator');
  const state = path.join(root, 'emu-state');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(dir, 'agreement'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // Named as oniro-app looks for it; the script itself only runs on POSIX.
  const binary = path.join(dir, process.platform === 'win32' ? 'Emulator.exe' : 'Emulator');
  fs.writeFileSync(binary, SCRIPT, { mode: 0o755 });
  fs.writeFileSync(
    path.join(dir, 'sdk-pkg.json'),
    JSON.stringify({ meta: { version: '1.0.0' }, data: { displayName: 'Emulator', path: 'emulator', version: '26.0.0.400' } }),
  );
  fs.writeFileSync(path.join(dir, 'agreement', `${SDK_AGREEMENT}.txt`), 'HarmonyOS SDK License Agreement\n\n1. Definition\n');
  fs.writeFileSync(
    path.join(dir, 'agreement', `${SERVICE_AGREEMENT}.txt`),
    '1/3:\n---------------------------------------\nHarmonyOS Software License and Service Agreement\n',
  );
  const cfg = path.join(home, 'Library', 'Caches', 'Huawei', 'Emulator26.0', '.emu_config');
  return {
    root,
    binary,
    dir,
    state,
    home,
    env: { ...process.env, HOME: home, FAKE_EMU_STATE: state },
    calls: () => {
      try {
        return fs.readFileSync(path.join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    write: (file, value) => fs.writeFileSync(path.join(state, file), typeof value === 'string' ? value : JSON.stringify(value, null, 4)),
    accept: (...agreements) => {
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, agreements.map((a) => `${a}:agree\n`).join(''));
    },
  };
}

/** A device as `Emulator -list -details` prints it (the fields oniro-app reads, plus a few it ignores). */
export function deviceRecord(name: string, over: Record<string, string> = {}): Record<string, string> {
  return {
    configPath: '/home/u/Library/Application Support/Huawei/DevEcoStudio26.0',
    deviceModel: 'PHEMU-FD00',
    deviceType: 'phone',
    'hw.cpu.arch': 'x86_64',
    'hw.cpu.ncore': '4',
    'hw.hdc.port': 'notset',
    'hw.lcd.density': '560',
    'hw.lcd.single.height': '2760',
    'hw.lcd.single.width': '1256',
    'hw.ramSize': '4096',
    imageRoot: '/home/u/hmos-sdk',
    imageSubPath: 'system-image/HarmonyOS-7.0.0/phone_all_x86/',
    instancePath: `/home/u/.Huawei/Emulator/deployed/${name}`,
    isRunning: 'false',
    name,
    'os.apiVersion': '26',
    'os.osVersion': 'HarmonyOS 7.0.0(26.0.0)',
    'os.softwareVersion': '7.0.0.107',
    productModel: 'Pura 90 Pro',
    ...over,
  };
}

/** An image as `Emulator -imageList` prints it. */
export function imageRecord(osVersion: string, deviceType: string, over: Record<string, string> = {}): Record<string, string> {
  return { SoftWareVersion: '7.0.0.107', deviceType, downloaded: 'false', osVersion, releaseType: 'Release', upgradable: 'false', ...over };
}

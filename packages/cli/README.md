# @oniroproject/oniro-app

Cross-platform CLI for Oniro/OpenHarmony application development. Drives the inner dev loop — SDK install, project scaffold, sign, build, emulator, and `hdc` install/launch — from a single binary that works on Linux, macOS, and Windows.

Designed for non-interactive use (CI, scripts, agents): every command takes explicit flags, results go to stdout, progress/logs go to stderr, and exit codes reflect success or failure.

## Install

Requires Node.js 20+. For `oniro-app sign` you also need a JDK on `PATH` (`java`, `keytool`).

```bash
npm install -g @oniroproject/oniro-app
oniro-app --help
```

## Typical workflow

```bash
oniro-app sdk install 6.1
oniro-app cmdtools install
oniro-app create --name HelloOniro --bundle com.example.hello \
                 --location ~/projects --sdk 23
cd ~/projects/HelloOniro
oniro-app sign
oniro-app build
oniro-app emulator install
oniro-app emulator start
oniro-app app install
oniro-app app launch
```

## Documentation

Full command reference, environment-variable configuration, and Docker usage live in the [repository README](https://github.com/eclipse-oniro4openharmony/oniro-app-builder#readme).

## License

Apache-2.0

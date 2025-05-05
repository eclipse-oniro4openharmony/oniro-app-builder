# Oniro App Builder

Oniro App Builder provides a Dockerized tool and a `.deb` package for building Oniro/OpenHarmony applications.

## Features
- Pre-configured environment for Oniro/OpenHarmony ArkTS applications.
- Dockerized solution for consistent builds.
- `.deb` package for easy installation of tools and SDK setup.
- `onirobuilder` executable for managing SDK, build, signing, and emulator commands.

## Getting Started

### Install Oniro App Builder
Download the latest `.deb` package from the [GitHub Releases](https://github.com/eclipse-oniro4openharmony/oniro-app-builder/releases) page or from the CI workflow artifacts, then install it:

```bash
$ sudo dpkg -i onirobuilder.deb
$ sudo apt-get install -fy  # Fix missing dependencies if needed
```

### Initialize the Environment
Run the following command to install the OpenHarmony SDK, required tools, and Oniro emulator:

```bash
$ onirobuilder init
```

- Use `--sdk-version <version>` to specify the SDK version (default: 5.0.0).
- Use `--no-env` to skip modifying your shell profile.

### Build an Application
Navigate to your application project and run:

```bash
$ onirobuilder build
```

The output files will be in the `output` directory.

### Signing a HAP Package
To generate the HAP signing certificates and profile, run:

```bash
$ onirobuilder sign
```

This updates the `build-profile.json5` file with the new signing configs.

### Using the Oniro Emulator
The Oniro emulator is installed during `onirobuilder init`. To start the emulator:

```bash
$ onirobuilder emulator [args...]
```

Any extra arguments are passed to the emulator.

## Using Docker
Alternatively, you can use the Dockerized environment:

### Prerequisites
Ensure [Docker](https://docs.docker.com/get-docker/) is installed.

1. Build the Docker image:

    ```bash
    $ docker build -t oniro-app-builder .
    ```

2. Build an application:

    ```bash
    $ docker run --rm -v $(pwd):/workspace oniro-app-builder build
    ```

3. Access the container's shell:

    ```bash
    $ docker run --rm -it -v $(pwd):/workspace --entrypoint bash oniro-app-builder
    ```

### Dockerfile Overview
The Dockerfile provides a complete environment for building Oniro/OpenHarmony ArkTS applications:
1. Uses `ubuntu:22.04` as the base image.
2. Installs dependencies (`curl`, `unzip`, `python3`, `nodejs`, etc.).
3. Installs the `.deb` package containing `onirobuilder`.
4. Runs `onirobuilder init` to set up the environment.
5. Sets `/workspace` as the working directory.
6. Builds the application and outputs artifacts to the `output` directory.

## Build and Test Sample App with Oniro Emulator

This repository includes a [GitHub Actions workflow](.github/workflows/build-test-app.yml) that automates building, signing, and testing a sample OpenHarmony application using the Oniro build system and emulator.

It consists of two main jobs: `build` and `emulator`.

#### Build Job

Runs in a Docker container with the Oniro build environment that has already been initialized with `onirobuilder init`.

Steps:

1. **Checkout Repository** – Retrieves source code.
2. **Build and Sign App** – Uses `onirobuilder` to sign and build the app located in `sample_app`.
3. **Upload Build Artifacts** – Stores the built app outputs and toolchains as artifacts for later use.

#### Emulator Job

Runs the built app in a headless Oniro emulator to validate functionality.

Steps:

1. **Download Artifacts** – Retrieves the built app and toolchains.
2. **Start Emulator** – Runs QEMU-based Oniro emulator using official images.
3. **Connect with HDC** – Initializes device communication using the `hdc` CLI.
4. **Install & Launch App** – Installs the signed `.hap` file and launches the entry ability.
5. **Capture Screenshot** – Takes a screenshot of the emulator screen via VNC.
6. **Upload Screenshot** – Saves emulator output for inspection.

### Artifacts Generated

* `sample_app_outputs`: Compiled and signed `.hap` app package
* `emulator-screenshot`: Screenshot of the app running in the emulator

## Contribution
Contributions are welcome! Create a pull request or open an issue for suggestions or issues.

## License
Licensed under [Apache License 2.0](LICENSE).

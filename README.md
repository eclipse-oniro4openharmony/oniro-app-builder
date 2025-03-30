# Oniro App Builder

Oniro App Builder provides a Dockerized tool for building Oniro/OpenHarmony applications.

## Features
- Pre-configured environment for Oniro/OpenHarmony ArkTS applications.
- Dockerized solution for consistent builds.
- Simple commands to build and package applications.

## Getting Started

### Prerequisites
Ensure [Docker](https://docs.docker.com/get-docker/) is installed.

### Build the Docker Image
Run the following command to build the Docker image:

```bash
$ docker build -t oniro-app-builder .
```

### Build an Application
Navigate to your application project and run:

```bash
$ docker run --rm -v $(pwd):/workspace oniro-app-builder
```

The output files will be in the `output` directory.

### Accessing the Container's Shell
To access the container's shell for debugging:

```bash
$ docker run --rm -it -v $(pwd):/workspace oniro-app-builder /bin/bash
```

### Signing a HAP Package

To generate the HAP signing certificates and profile, run the following command. 
By running this command, the `build-profile.json5` file will be updated with the new signing configs.

```bash
$ docker run --rm -it -v $(pwd):/workspace oniro-app-builder builder.sh --generate-signing-configs
```

## Dockerfile Overview
The Dockerfile provides a complete environment for building Oniro/OpenHarmony ArkTS applications:
1. Uses `ubuntu:22.04` as the base image.
2. Installs dependencies (`curl`, `unzip`, `python3`, `nodejs`, etc.).
3. Downloads and installs OpenHarmony SDK.
4. Install project dependencies such as hvigorw, ohpm
5. Sets `/workspace` as the working directory.
6. Builds the application and outputs artifacts to the `output` directory.

## Environment Variables
- `OHOS_SDK_VERSION`: OpenHarmony SDK version.

## Contribution
Contributions are welcome! Create a pull request or open an issue for suggestions or issues.

## License
Licensed under [Apache License 2.0](LICENSE).

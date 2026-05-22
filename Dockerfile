# Container image for the Oniro/OpenHarmony toolchain.
#
# Provides `oniro-app` on PATH plus a pre-installed OpenHarmony SDK + command-line tools,
# so consumers can mount their project at /workspace and run sign/build without per-run downloads.
#
# Layout inside the image:
#   /opt/oniro/sdk            — SDK root (ONIRO_SDK_ROOT_DIR)
#   /opt/oniro/cmd-tools      — command-line tools (ONIRO_CMD_TOOLS_PATH)
#
# Override via -e ONIRO_SDK_ROOT_DIR=... etc. at `docker run` time.
#
# Defaults to SDK 6.1 (api 23) — change with --build-arg ONIRO_SDK_VERSION=6.0.
#
# Multi-stage:
#   builder — copies sources, builds the CLI, npm-installs it globally. No network downloads.
#             CI builds this stage via `docker build --target builder` to validate the pipeline.
#   runtime — builder + the SDK and command-line-tools download. This is the default target.

FROM node:20-slim AS base

ENV ONIRO_SDK_ROOT_DIR=/opt/oniro/sdk \
    ONIRO_CMD_TOOLS_PATH=/opt/oniro/cmd-tools \
    DEBIAN_FRONTEND=noninteractive

# JDK is required for the OpenHarmony hap-sign-tool (run during `oniro-app sign`).
# git is needed by some hvigor plugins. curl/unzip/ca-certificates are baseline.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openjdk-17-jre-headless \
        unzip \
    && rm -rf /var/lib/apt/lists/*


FROM base AS builder

# Copy the monorepo (just the package manifests first to leverage Docker layer cache),
# install, build, and install the CLI globally.
WORKDIR /opt/oniro-app-builder
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
RUN npm ci

COPY packages ./packages
RUN npm run build \
    && npm install -g ./packages/cli \
    && npm cache clean --force


FROM builder AS runtime

ARG ONIRO_SDK_VERSION=6.1

# Pre-install the SDK + cmd-tools so `oniro-app build` works offline at runtime.
RUN oniro-app sdk install "${ONIRO_SDK_VERSION}" \
    && oniro-app cmdtools install

WORKDIR /workspace
ENTRYPOINT ["oniro-app"]

# Dockerfile for building an Oniro/OpenHarmony application

# Use a base image with required build tools
FROM ubuntu:22.04

# Use bash shell
SHELL ["/bin/bash", "-c"] 

# Install dependencies
RUN apt update && \
    apt install -y curl unzip python3 python3-pip openjdk-11-jdk git jq && \
    python3 -m pip install --upgrade pip && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt install -y nodejs

# Set environment variables
ENV HOME=/root
ENV OHOS_SDK_VERSION=5.0.0

# Copy and run install_ohos_sdk.sh
COPY tools/install_ohos_sdk.sh /tmp/install_ohos_sdk.sh
RUN chmod +x /tmp/install_ohos_sdk.sh && \
    export INPUT_VERSION=$OHOS_SDK_VERSION && \
    export INPUT_MIRROR="false" && \
    export INPUT_COMPONENTS="all" && \
    export INPUT_FIXUP_PATH="true" && \
    export INPUT_CACHE="false" && \
    export INPUT_WAS_CACHED="false" && \
    source /tmp/install_ohos_sdk.sh

# Copy the entire tools directory
COPY ./tools /root/tools

# Set permissions for scripts in the tools directory
RUN chmod +x /root/tools/*.sh

# Run npm install inside the /root/tools directory
RUN cd /root/tools && npm install

# Set OHOS_BASE_SDK_HOME environment variable
ENV OHOS_BASE_SDK_HOME="${HOME}/setup-ohos-sdk/linux"

# Setup .npmrc File
RUN echo "@ohos:registry=https://repo.harmonyos.com/npm/" > $HOME/.npmrc

# Install command line tools
ENV CMD_PATH="/root/command-line-tools"

# Run cmd_tools_installer.sh from the tools directory
RUN source /root/tools/cmd_tools_installer.sh

# Add cmd-tools to PATH
ENV PATH="$PATH:$CMD_PATH/bin"

# Set work directory
ENV PROJECT_PATH=/workspace
WORKDIR /workspace

# Set the default command to run builder
CMD ["/root/tools/builder.sh"]

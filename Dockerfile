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
ENV OHOS_SDK_VERSION=4.1

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
ENV TOOLS_DIR=/root/tools
COPY ./tools $TOOLS_DIR

# Set permissions for scripts in the tools directory
RUN chmod +x $TOOLS_DIR/*.sh

# Run npm install inside the tools directory
RUN cd $TOOLS_DIR && npm install

# Set OHOS_BASE_SDK_HOME environment variable
ENV OHOS_BASE_SDK_HOME="${HOME}/setup-ohos-sdk/linux"
ENV OHOS_SDK_API=11

# Setup .npmrc File
RUN echo "@ohos:registry=https://repo.harmonyos.com/npm/" > $HOME/.npmrc

# Install command line tools
ENV CMD_PATH="/root/command-line-tools"

# Run cmd_tools_installer.sh from the tools directory
RUN source $TOOLS_DIR/cmd-tools/sdk-11/installer.sh

# Add cmd-tools and TOOLS_DIR to PATH
ENV PATH="$PATH:$CMD_PATH/bin:$TOOLS_DIR"

# Set work directory
WORKDIR /workspace

# Set the default command to run builder
CMD ["builder.sh"]

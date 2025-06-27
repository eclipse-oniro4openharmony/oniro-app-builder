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

# Copy the local debian package directory into the image
COPY onirobuilder_deb /tmp/onirobuilder_deb

# Build the .deb package from the directory
RUN dpkg-deb --build /tmp/onirobuilder_deb /tmp/onirobuilder.deb

# Install the .deb package (ignore errors for missing deps, fix later)
RUN dpkg -i /tmp/onirobuilder.deb || apt-get install -fy

# (Optional) Remove the deb package to keep image smaller
RUN rm /tmp/onirobuilder.deb

# Run `onirobuilder init` to set up dependencies
RUN onirobuilder init --no-env --sdk-version 5.1.0

# remove temporary files to keep the image smaller
RUN rm -rf /tmp/*

# Set work directory
WORKDIR /workspace

# Set the default command to run builder
ENTRYPOINT ["/usr/bin/onirobuilder"]

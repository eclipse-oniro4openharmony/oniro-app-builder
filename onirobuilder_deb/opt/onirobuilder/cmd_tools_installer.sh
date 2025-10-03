#!/usr/bin/env bash

# Enable strict error handling
set -e # Exit on error

# Start main log group for better visualization in GitHub Actions
echo "::group::Setting up OpenHarmony command-line tools for SDK 12"

# Validate required environment variables
# CMD_PATH: Directory where tools will be installed
for var in CMD_PATH ; do
    if [ -z "${!var}" ]; then
        echo "::error::Required environment variable $var is not set"
        exit 1
    fi
done

# Output debug information for troubleshooting
echo "::debug::CMD_PATH: $CMD_PATH"

# Install command line tools
setup_cmd_tools() {
    echo "::group::Setting up OHPM..."
    # Create installation directory
    mkdir -p "$CMD_PATH"

    # extract oh-command-line-tools
    curl -L "https://repo.huaweicloud.com/harmonyos/ohpm/5.1.0/commandline-tools-linux-x64-5.1.0.840.zip" -o /tmp/oh-command-line-tools.zip
    unzip /tmp/oh-command-line-tools.zip -d /tmp/oh-command-line-tools
    mv /tmp/oh-command-line-tools/command-line-tools/* "$CMD_PATH"
    rm -rf /tmp/oh-command-line-tools
    rm /tmp/oh-command-line-tools.zip

    # Make all files in bin directory executable
    if ! chmod +x "$CMD_PATH/bin/"*; then
        echo "::error::Failed to set executable permissions"
        return 1
    fi
    echo "::endgroup::"
}

# Configure environment variables and verify installation
setup_environment() {
    echo "::group::Setting up environment..."

    # Add to current session PATH
    export PATH="$CMD_PATH/bin:$PATH"

    # Verify OHPM is accessible
    if ! command -v ohpm &>/dev/null; then
        echo "::error::ohpm not found in PATH"
        return 1
    fi

    # Display installation information
    echo "ohpm location: $(which ohpm)"
    ohpm -v
    echo "::endgroup::"
}

# Main installation sequence
main() {
    setup_cmd_tools || exit 1
    setup_environment || exit 1
    echo "::notice::OpenHarmony tools installation completed successfully"
}

# Execute installation
main

# Close the main log group
echo "::endgroup::"

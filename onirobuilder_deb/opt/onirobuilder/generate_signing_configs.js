"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const encryptKey = require("./encrypt_key");
const json5 = require("json5");

// Define constants for SDK paths
const SDK_HOME = process.env.OHOS_BASE_SDK_HOME;

// Function to get SDK paths based on API version
function getSdkPaths(apiVersion) {
    return {
        SIGN_TOOL_PATH: path.join(SDK_HOME, `${apiVersion}/toolchains/lib/hap-sign-tool.jar`),
        KEYSTORE_FILE: path.join(SDK_HOME, `${apiVersion}/toolchains/lib/OpenHarmony.p12`),
        PROFILE_CERT_FILE: path.join(SDK_HOME, `${apiVersion}/toolchains/lib/OpenHarmonyProfileRelease.pem`),
        UNSIGNED_PROFILE_TEMPLATE: path.join(SDK_HOME, `${apiVersion}/toolchains/lib/UnsgnedReleasedProfileTemplate.json`)
    };
}

// Function to get API version from build-profile.json5
function getApiVersionFromBuildProfile(projectDir) {
    const buildProfilePath = path.join(projectDir, "build-profile.json5");
    
    if (!fs.existsSync(buildProfilePath)) {
        console.error(`Error: ${buildProfilePath} does not exist.`);
        process.exit(1);
    }

    let buildProfile;
    try {
        buildProfile = json5.parse(fs.readFileSync(buildProfilePath, "utf-8"));
    } catch (e) {
        console.error(`Error parsing ${buildProfilePath}: ${e.message}`);
        process.exit(1);
    }

    if (!buildProfile.app || !buildProfile.app.products || !buildProfile.app.products[0] || !buildProfile.app.products[0].compileSdkVersion) {
        console.error(`Error: build-profile.json5 does not contain the required compileSdkVersion field.`);
        process.exit(1);
    }

    return buildProfile.app.products[0].compileSdkVersion;
}

// Function to copy necessary files to the project directory
function copyFilesToProject(projectDir, sdkPaths) {
    console.log("Copying files to project directory...");
    const signaturesDir = path.join(projectDir, "signatures");
    fs.mkdirSync(signaturesDir, { recursive: true });

    fs.copyFileSync(sdkPaths.KEYSTORE_FILE, path.join(signaturesDir, "OpenHarmony.p12"));
    fs.copyFileSync(sdkPaths.PROFILE_CERT_FILE, path.join(signaturesDir, "OpenHarmonyProfileRelease.pem"));
    fs.copyFileSync(sdkPaths.UNSIGNED_PROFILE_TEMPLATE, path.join(signaturesDir, "UnsgnedReleasedProfileTemplate.json"));
    console.log("Files copied successfully.");
}

// Function to modify the profile template with the app's bundle name and distribution certificate
function modifyProfileTemplate(projectDir) {
    console.log("Modifying profile template...");
    const appJsonPath = path.join(projectDir, "AppScope/app.json5");
    const profileTemplatePath = path.join(projectDir, "signatures/UnsgnedReleasedProfileTemplate.json");
    const profileCertFilePath = path.join(projectDir, "signatures/OpenHarmonyProfileRelease.pem");

    if (!fs.existsSync(appJsonPath)) {
        console.error(`Error: ${appJsonPath} does not exist.`);
        process.exit(1);
    }

    let appJson;
    try {
        appJson = json5.parse(fs.readFileSync(appJsonPath, "utf-8"));
    } catch (e) {
        console.error(`Error parsing ${appJsonPath}: ${e.message}`);
        process.exit(1);
    }

    let profileTemplate;
    try {
        profileTemplate = JSON.parse(fs.readFileSync(profileTemplatePath, "utf-8"));
    } catch (e) {
        console.error(`Error parsing ${profileTemplatePath}: ${e.message}`);
        process.exit(1);
    }

    if (!appJson["app"] || !appJson["app"]["bundleName"]) {
        console.error(`Error: app.json5 does not contain the required fields.`);
        process.exit(1);
    }

    if (!profileTemplate["bundle-info"]) {
        console.error(`Error: UnsgnedReleasedProfileTemplate.json does not contain the required fields.`);
        process.exit(1);
    }

    profileTemplate["bundle-info"]["bundle-name"] = appJson["app"]["bundleName"];

    // Extract the third certificate from OpenHarmonyProfileRelease.pem
    const certContent = fs.readFileSync(profileCertFilePath, "utf-8");
    const certs = certContent.split("-----END CERTIFICATE-----");
    if (certs.length < 3) {
        console.error(`Error: ${profileCertFilePath} does not contain enough certificates.`);
        process.exit(1);
    }
    const thirdCert = certs[2].trim() + "\n-----END CERTIFICATE-----\n";
    profileTemplate["bundle-info"]["distribution-certificate"] = thirdCert;

    fs.writeFileSync(profileTemplatePath, JSON.stringify(profileTemplate, null, 2));
    console.log("Profile template modified successfully.");
}

// Function to generate the P7b file using the signing tool
function generateP7bFile(projectDir, sdkPaths) {
    console.log("Generating P7b file...");
    const signaturesDir = path.join(projectDir, "signatures");
    const profileTemplatePath = path.join(signaturesDir, "UnsgnedReleasedProfileTemplate.json");
    const outputProfilePath = path.join(signaturesDir, "app1-profile.p7b");

    const command = `java -jar ${sdkPaths.SIGN_TOOL_PATH} sign-profile \
    -keyAlias "openharmony application profile release" \
    -signAlg "SHA256withECDSA" \
    -mode "localSign" \
    -profileCertFile "${sdkPaths.PROFILE_CERT_FILE}" \
    -inFile "${profileTemplatePath}" \
    -keystoreFile "${sdkPaths.KEYSTORE_FILE}" \
    -outFile "${outputProfilePath}" \
    -keyPwd "123456" \
    -keystorePwd "123456"`;

    execSync(command);
    console.log("P7b file generated successfully.");
}

// Function to update the build profile with encrypted passwords and signing configs
function updateBuildProfile(projectDir) {
    console.log("Updating build profile...");
    const materialDir = path.join(projectDir, "signatures", "material");
    const buildProfilePath = path.join(projectDir, "build-profile.json5");

    const encryptedStorePassword = encryptKey.encryptPwd("123456", materialDir);
    const encryptedKeyPassword = encryptKey.encryptPwd("123456", materialDir);

    let buildProfile;
    if (fs.existsSync(buildProfilePath)) {
        try {
            buildProfile = json5.parse(fs.readFileSync(buildProfilePath, "utf-8"));
        } catch (e) {
            console.error(`Error parsing ${buildProfilePath}: ${e.message}`);
            process.exit(1);
        }
    } else {
        buildProfile = { app: {} };
    }

    buildProfile.app.signingConfigs = [
        {
            name: "default",
            material: {
                certpath: "./signatures/OpenHarmonyProfileRelease.pem",
                storePassword: encryptedStorePassword,
                keyAlias: "openharmony application profile release",
                keyPassword: encryptedKeyPassword,
                profile: "./signatures/app1-profile.p7b",
                signAlg: "SHA256withECDSA",
                storeFile: "./signatures/OpenHarmony.p12"
            }
        }
    ];

    fs.writeFileSync(buildProfilePath, json5.stringify(buildProfile, null, 2));
    console.log("Build profile updated successfully.");
}

// Function to prepare the material directory by creating necessary files
function prepareMaterialDirectory(projectDir) {
    console.log("Preparing material directory...");
    const materialDir = path.join(projectDir, "signatures", "material");

    if (fs.existsSync(materialDir)) {
        fs.rmSync(materialDir, { recursive: true, force: true });
        console.log("Existing material directory removed.");
    }

    encryptKey.createMaterial(materialDir);
    console.log("Material directory prepared successfully.");
}

// Main function to orchestrate the signing configuration generation
function main() {
    let projectDir = process.argv[2];
    if (!projectDir) {
        console.log("No project directory provided. Using the current directory.");
        projectDir = process.cwd();
    }

    console.log("Starting signing configuration generation...");
    
    // Get API version from build profile
    const apiVersion = getApiVersionFromBuildProfile(projectDir);
    console.log(`Using API version: ${apiVersion}`);
    
    // Get SDK paths based on API version
    const sdkPaths = getSdkPaths(apiVersion);
    
    copyFilesToProject(projectDir, sdkPaths);
    modifyProfileTemplate(projectDir);
    generateP7bFile(projectDir, sdkPaths);
    prepareMaterialDirectory(projectDir);
    updateBuildProfile(projectDir);

    console.log("Signing configuration generated successfully.");
}

main();

// this file is used by 'Minio-Test-Server' and 'Minio-Test-Server-global' (and '-global-x.x') as an shared install script
// in this file the types for variables are set *explicitly* to prevent issues on type changes

const {homedir} = require("os");
const {resolve} = require("path");
const {MinioBinary} = require("./MinioBinary");
const minioBinary = new MinioBinary();
const {
    envName,
    envToBool,
    findPackageJson,
    resolveConfig,
    ResolveConfigVariables,
    setDefaultValue
} = require("./resolveConfig");


findPackageJson(process.env.INIT_CWD)

if (!!envToBool(resolveConfig(ResolveConfigVariables.DISABLE_POSTINSTALL))) {
    console.log(
        'Minio-Test-Server* postinstall skipped because "DISABLE_POSTINSTALL" was set to an truthy value'
    )
    process.exit(0)
}

// value is ensured to be either a string (with more than 0 length) or being undefined
if (typeof resolveConfig(ResolveConfigVariables.SYSTEM_BINARY) === "string") {
    console.log(
        'Minio-Test-Server* postinstall skipped because "SYSTEM_BINARY" was provided'
    )
    process.exit(0)
}

async function postInstallEnsureBinary(version, local) {
    console.log("Minio-Test-Server* checking Minio binaries")

    if (!local) {
        // set "DOWNLOAD_DIR" to ~/.cache
        setDefaultValue(
            ResolveConfigVariables.DOWNLOAD_DIR,
            resolve(homedir(), ".cache", "minio-binaries")
        )
    }

    if (version) {
        // if "version" is defined, apply it
        setDefaultValue(ResolveConfigVariables.VERSION, version)
    }

    process.env[envName(ResolveConfigVariables.RUNTIME_DOWNLOAD)] = "true" // To make sure to actually download in an postinstall

    const binPath = await minioBinary.getPath().catch(err => {
        console.warn(
            "Minio-Test-Server* failed to find a binary:\n",
            err.message,
            err.stack
        )
        process.exit(0) // Exiting with "0" to not fail the install (because it is an problem that can be solved otherwise)
    })
    console.log(`Minio-Test-Server* found binary: "${binPath}"`)
}

module.exports = {
    postInstallEnsureBinary
}


postInstallEnsureBinary(undefined, true);

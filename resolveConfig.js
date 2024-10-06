const camelCase = require("camelcase");
const { findSync } = require("new-find-package-json");
const debug = require("debug");
const path = require("path");
const { readFileSync } = require("fs");
const { isNullOrUndefined } = require("./utils");

const log = debug("MinioTST:ResolveConfig")

/** Enum of all possible config options */
let ResolveConfigVariables

;(function(ResolveConfigVariables) {
    ResolveConfigVariables["DOWNLOAD_DIR"] = "DOWNLOAD_DIR"
    ResolveConfigVariables["PLATFORM"] = "PLATFORM"
    ResolveConfigVariables["ARCH"] = "ARCH"
    ResolveConfigVariables["VERSION"] = "VERSION"
    ResolveConfigVariables["DEBUG"] = "DEBUG"
    ResolveConfigVariables["DOWNLOAD_MIRROR"] = "DOWNLOAD_MIRROR"
    ResolveConfigVariables["DOWNLOAD_URL"] = "DOWNLOAD_URL"
    ResolveConfigVariables["PREFER_GLOBAL_PATH"] = "PREFER_GLOBAL_PATH"
    ResolveConfigVariables["DISABLE_POSTINSTALL"] = "DISABLE_POSTINSTALL"
    ResolveConfigVariables["SYSTEM_BINARY"] = "SYSTEM_BINARY"
    ResolveConfigVariables["MD5_CHECK"] = "MD5_CHECK"
    ResolveConfigVariables["ARCHIVE_NAME"] = "ARCHIVE_NAME"
    ResolveConfigVariables["RUNTIME_DOWNLOAD"] = "RUNTIME_DOWNLOAD"
    ResolveConfigVariables["USE_HTTP"] = "USE_HTTP"
    ResolveConfigVariables["SYSTEM_BINARY_VERSION_CHECK"] =
        "SYSTEM_BINARY_VERSION_CHECK"
    ResolveConfigVariables["USE_ARCHIVE_NAME_FOR_BINARY_NAME"] =
        "USE_ARCHIVE_NAME_FOR_BINARY_NAME"
    ResolveConfigVariables["MAX_REDIRECTS"] = "MAX_REDIRECTS"
    ResolveConfigVariables["DISTRO"] = "DISTRO"
})(ResolveConfigVariables || (ResolveConfigVariables = {}))

/** The Prefix for Environmental values */
const ENV_CONFIG_PREFIX = "MINIOTST_"
/** This Value exists here, because "defaultValues" can be changed with "setDefaultValue", but this property is constant */
const DEFAULT_VERSION = "minio.RELEASE.2024-10-02T17-50-41Z"
/** Default values for some config options that require explicit setting, it is constant so that the default values cannot be interfered with */
const defaultValues = new Map([
    // apply app-default values here
    [ResolveConfigVariables.VERSION, DEFAULT_VERSION],
    [ResolveConfigVariables.PREFER_GLOBAL_PATH, "true"],
    [ResolveConfigVariables.RUNTIME_DOWNLOAD, "true"],
    [ResolveConfigVariables.USE_HTTP, "false"],
    [ResolveConfigVariables.SYSTEM_BINARY_VERSION_CHECK, "true"],
    [ResolveConfigVariables.USE_ARCHIVE_NAME_FOR_BINARY_NAME, "false"],
    [ResolveConfigVariables.MAX_REDIRECTS, "2"]
])

/**
 * Set an Default value for an specific key
 * Mostly only used internally (for the "global-x.x" packages)
 * @param key The Key the default value should be assigned to
 * @param value The Value what the default should be
 */
function setDefaultValue(key, value) {
    defaultValues.set(key, value)
}

/** Cache the found package.json file */
let packagejson = undefined
/**
 * Find the nearest package.json (that has an non-empty config field) for the provided directory
 * @param directory Set an custom directory to search the config in (default: process.cwd())
 * @returns what "packagejson" variable is
 */
function findPackageJson(directory) {
    for (const filename of findSync(directory || process.cwd())) {
        log(`findPackageJson: Found package.json at "${filename}"`)
        const readout = JSON.parse(readFileSync(filename).toString())

        /** Shorthand for the long path */
        const config = readout?.config?.minioTestServer

        if (!isNullOrUndefined(config) && Object.keys(config ?? {}).length > 0) {
            log(
                `findPackageJson: Found package with non-empty config field at "${filename}"`
            )

            const filepath = path.dirname(filename)

            packagejson = {
                filePath: filepath,
                config: processConfigOption(config, filepath)
            }
            break
        }
    }

    return packagejson
}

/**
 * Apply Proccessing to input options (like resolving paths)
 * @param input The input to process
 * @param filepath The FilePath for the input to resolve relative paths to (needs to be a dirname and absolute)
 * @returns always returns a object
 */
function processConfigOption(input, filepath) {
    log("processConfigOption", input, filepath)

    if (typeof input !== "object") {
        log("processConfigOptions: input was not a object")

        return {}
    }

    // cast because it was tested before that "input" is a object and the key can only be a string in a package.json
    const returnobj = input

    // These are so that "camelCase" doesnt get executed much & de-duplicate code
    // "cc*" means "camelcase"
    const ccDownloadDir = camelCase(ResolveConfigVariables.DOWNLOAD_DIR)
    const ccSystemBinary = camelCase(ResolveConfigVariables.SYSTEM_BINARY)

    if (ccDownloadDir in returnobj) {
        returnobj[ccDownloadDir] = path.resolve(filepath, returnobj[ccDownloadDir])
    }

    if (ccSystemBinary in returnobj) {
        returnobj[ccSystemBinary] = path.resolve(
            filepath,
            returnobj[ccSystemBinary]
        )
    }

    return returnobj
}

/**
 * Resolve "variableName" value (process.env | packagejson | default | undefined)
 * @param variableName The variable to search an value for
 */
function resolveConfig(variableName) {
    return (
        process.env[envName(variableName)] ??
        packagejson?.config[camelCase(variableName)] ??
        defaultValues.get(variableName)
    )?.toString()
}


/**
 * Helper Function to add the prefix for "process.env[]"
 */
function envName(variableName) {
    return `${ENV_CONFIG_PREFIX}${variableName}`
}

/**
 * Convert "1, on, yes, true" to true (otherwise false)
 * @param env The String / Environment Variable to check
 */
function envToBool(env = "") {
    if (typeof env !== "string") {
        log("envToBool: input was not a string!")

        return false
    }

    return ["1", "on", "yes", "true"].indexOf(env.toLowerCase()) !== -1
}

// enable debug if "MINIOTST_DEBUG" is true
if (envToBool(resolveConfig(ResolveConfigVariables.DEBUG))) {
    debug.enable("MinioTST:*")
    log("Debug Mode Enabled, through Environment Variable")
}

// run this after env debug enable to be able to debug this function too
findPackageJson()

// enable debug if "config.mongodbMemoryServer.debug" is true
if (
    envToBool(resolveConfig(ResolveConfigVariables.DEBUG)) &&
    !debug.enabled("MinioTST:*")
) {
    debug.enable("MinioTST:*")
    log("Debug Mode Enabled, through package.json")
}

module.exports = {
    ResolveConfigVariables,
    findPackageJson,
    resolveConfig,
    envName,
    envToBool,
    setDefaultValue
}

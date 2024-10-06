const debug = require("debug")
const {promises, constants} = require("fs")
const fspromises = promises;
const {
    AssertionFallbackError,
    BinaryNotFoundError,
    InsufficientPermissionsError
} = require("./errors");
const {tmpdir} = require("os")
const path = require("path")

const log = debug("MinioTST:utils")

/**
 * This is here, because NodeJS does not have a FSError type
 * @param err Value to check against
 * @returns `true` if it is an error with code, `false` if not
 */
function errorWithCode(err) {
    return err instanceof Error && "code" in err
}

/**
 * Return input or default database
 * @param {string} dbName
 */
function generateDbName(dbName) {
    // this is ""(empty) to make it compatible with mongodb's uri format and mongoose's uri format
    // (in mongodb its the auth database, in mongoose its the default database for models)
    return dbName || ""
}

/**
 * Extracts the host and port information= require(a mongodb URI string.
 * @param {string} uri mongodb URI
 */
function getHost(uri) {
    // this will turn "mongodb://user:pass@localhost:port/authdb?queryoptions=1" to "localhost:port"
    return uri.replace(/(?:^mongodb:\/{2})|(?:\/.*$)|(?:.*@)/gim, "")
}

/**
 * Basic MongoDB Connection string
 * @param host the host ip or an list of hosts
 * @param port the host port or undefined if "host" is an list of hosts
 * @param dbName the database to add to the uri (in mongodb its the auth database, in mongoose its the default database for models)
 * @param query extra uri-query options (joined with "&")
 */
function uriTemplate(host, port, dbName, query) {
    const hosts = !isNullOrUndefined(port) ? `${host}:${port}` : host

    return (
        `mongodb://${hosts}/${dbName}` +
        (!isNullOrUndefined(query) ? `?${query.join("&")}` : "")
    )
}

/**
 * Because since node 4.0.0 the internal util.is* functions got deprecated
 * @param val Any value to test if null or undefined
 */
function isNullOrUndefined(val) {
    return val === null || val === undefined
}

/**
 * Assert an condition, if "false" throw error
 * Note: it is not named "assert" to differentiate between node and jest types
 * @param cond The Condition to throw
 * @param error An Custom Error to throw
 */
function assertion(cond, error) {
    if (!cond) {
        throw error ?? new AssertionFallbackError()
    }
}

/**
 * Kill an ChildProcess
 * @param childprocess The Process to kill
 * @param name the name used in the logs
 * @param minioPort the port for the minio process (for easier logging)
 */
async function killProcess(childprocess, name, minioPort) {
    function ilog(msg) {
        log(`Minio[${minioPort || "unknown"}] killProcess: ${msg}`)
    }

    // this case can somehow happen, see https://github.com/nodkz/mongodb-memory-server/issues/666
    if (isNullOrUndefined(childprocess)) {
        ilog("childprocess was somehow undefined")

        return
    }

    // check if the childProcess (via PID) is still alive (found thanks to https://github.com/nodkz/mongodb-memory-server/issues/411)
    if (!isAlive(childprocess.pid)) {
        ilog("given childProcess's PID was not alive anymore")

        return
    }

    /**
     * Timeout before using SIGKILL
     */
    const timeoutTime = 1000 * 10
    await new Promise((res, rej) => {
        let timeout = setTimeout(() => {
            ilog("timeout triggered, trying SIGKILL")

            if (!debug.enabled("MinioTST:utils")) {
                console.warn(
                    'An Process didnt exit with signal "SIGINT" within 10 seconds, using "SIGKILL"!\n' +
                    "Enable debug logs for more information"
                )
            }

            childprocess.kill("SIGKILL")
            timeout = setTimeout(() => {
                ilog("timeout triggered again, rejecting")
                rej(
                    new Error(
                        `Process "${name}" didnt exit, enable debug for more information.`
                    )
                )
            }, timeoutTime)
        }, timeoutTime)
        childprocess.once(`exit`, (code, signal) => {
            ilog(`${name}: got exit signal, Code: ${code}, Signal: ${signal}`)
            clearTimeout(timeout)
            res()
        })
        ilog(`${name}: sending "SIGINT"`)
        childprocess.kill("SIGINT")
    })
}

/**
 * Check if the given Process is still alive
 * @param {number} pid The Process PID
 */
function isAlive(pid) {
    // This test (and allow to be undefined) is here because somewhere between nodejs 12 and 16 the types for "childprocess.pid" changed to include "| undefined"
    if (isNullOrUndefined(pid)) {
        return false
    }

    try {
        process.kill(pid, 0) // code "0" dosnt actually kill anything (on all supported systems)

        return true
    } catch (err) {
        return false
    }
}

/**
 * Call "process.nextTick" to ensure an function is exectued directly after all code surrounding it
 * look at the following link to get to know on why this needed: https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick/#process-nexttick (read full documentation)
 */
async function ensureAsync() {
    return new Promise(res => process.nextTick(res))
}

/**
 * Convert Partitial input into full-defaulted output
 * @param opts Partitial input options
 */
function authDefault(opts) {
    return {
        force: false,
        disable: false,
        customRootName: "minio-test-server-root",
        customRootPwd: "rootuser",
        extraUsers: [],
        keyfileContent: "0123456789",
        ...opts
    }
}

/**
 * Run "fs.promises.stat", but return "undefined" if error is "ENOENT" or "EACCES"
 * follows symlinks
 * @param path The Path to Stat
 * @throws if the error is not "ENOENT" or "EACCES"
 */
async function statPath(path) {
    return fspromises.stat(path).catch(err => {
        // catch the error if the directory doesn't exist or permission is denied, without throwing an error
        if (["ENOENT", "EACCES"].includes(err.code)) {
            return undefined
        }

        throw err
    })
}

/**
 * Like "fs.existsSync" but async
 * uses "utils.statPath"
 * follows symlinks
 * @param path The Path to check for
 */
async function pathExists(path) {
    return !isNullOrUndefined(await statPath(path))
}

/**
 * Try to read an release file path and apply an parser to the output
 * @param path The Path to read for an release file
 * @param parser An function to parse the output of the file
 */
async function tryReleaseFile(path, parser) {
    try {
        const output = await fspromises.readFile(path)

        return parser(output.toString())
    } catch (err) {
        if (errorWithCode(err) && !["ENOENT", "EACCES"].includes(err.code)) {
            throw err
        }

        log(`tryReleaseFile: "${path}" does not exist`)

        return undefined
    }
}

/**
 * This Class is used to have unified types for base-manager functions
 */
class ManagerBase {
}

/**
 * This Class is used to have unified types for advanced-manager functions
 */
class ManagerAdvanced extends ManagerBase {
}

/**
 * Check that the Binary has sufficient Permissions to be executed
 * @param path The Path to check
 */
async function checkBinaryPermissions(path) {
    try {
        // give execute permission to the owner of the file
        await fspromises.chmod(path, 0o755)
        await fspromises.access(path, constants.X_OK) // check if the provided path exists and has the execute bit for current user
    } catch (err) {
        if (errorWithCode(err)) {
            if (err.code === "EACCES") {
                throw new InsufficientPermissionsError(path)
            }
            if (err.code === "ENOENT") {
                throw new BinaryNotFoundError(path)
            }
        }

        throw err
    }
}

/**
 * Make Directory, wrapper for native mkdir with recursive true
 * @param path The Path to create
 * @returns Nothing
 */
async function mkdir(path) {
    await fspromises.mkdir(path, {recursive: true})
}

/**
 * Create a Temporary directory with prefix, and optionally at "atPath"
 * @param prefix The prefix to use to create the tmpdir
 * @param atPath Optionally set a custom path other than "os.tmpdir"
 * @returns The created Path
 */
async function createTmpDir(prefix, atPath) {
    const tmpPath = atPath ?? tmpdir()

    return fspromises.mkdtemp(path.join(tmpPath, prefix))
}

/**
 * Removes the given "path", if it is a directory, and does not throw a error if not existing
 * @param dirPath The Directory Path to delete
 * @returns "true" if deleted, otherwise "false"
 */
async function removeDir(dirPath) {
    const stat = await statPath(dirPath)

    if (isNullOrUndefined(stat)) {
        return
    }

    if (!stat.isDirectory()) {
        throw new Error(`Given Path is not a directory! (Path: "${dirPath}")`)
    }

    if ("rm" in fspromises) {
        // only since NodeJS 14
        await fspromises.rm(dirPath, {force: true, recursive: true})
    } else {
        // before NodeJS 14
        // needs the bridge via the interface, because we are using @types/node 14, where this if evaluates to a always "true" in typescript's eyes
        await fspromises.rmdir(dirPath, {
            recursive: true
        })
    }
}

module.exports = {
    ManagerBase,
    ManagerAdvanced,
    uriTemplate,
    getHost,
    generateDbName,
    isNullOrUndefined,
    assertion,
    killProcess,
    isAlive,
    ensureAsync,
    authDefault,
    statPath,
    pathExists,
    tryReleaseFile,
    checkBinaryPermissions,
    mkdir,
    createTmpDir,
    removeDir
}

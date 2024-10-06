const os = require("os");
const path = require("path");
const { MinioBinaryDownload } = require("./MinioBinaryDownload");
const {
    envToBool,
    ResolveConfigVariables,
    resolveConfig
} = require("./resolveConfig");
const debug = require("debug");
const semver = require("semver");
const { assertion, isNullOrUndefined, mkdir } = require("./utils");
const { spawnSync } = require("child_process");
const { LockFile } = require("./lockfile");
const lockFile = new LockFile();
const { DryMinioBinary } = require("./DryMinioBinary");
const dryMinioBinary = new DryMinioBinary();

const log = debug("MinioTST:MinioBinary")

/**
 * Class used to combine "DryMinioBinary" & "MinioBinaryDownload"
 */
class MinioBinary {

    constructor() {
    }
    /**
     * Probe download path and download the binary
     * @param options Options Configuring which binary to download and to which path
     * @returns The BinaryPath the binary has been downloaded to
     */
    async download(options) {
        log("download")
        const { downloadDir, version } = options
        // create downloadDir
        await mkdir(downloadDir)

        /** Lockfile path */
        const lockfile = path.resolve(downloadDir, `${version}.lock`)
        log(`download: Waiting to acquire Download lock for file "${lockfile}"`)
        // wait to get a lock
        // downloading of binaries may be quite long procedure
        // that's why we are using so big wait/stale periods
        const lock = await lockFile.lock(lockfile)
        log("download: Download lock acquired")

        // this is to ensure that the lockfile gets removed in case of an error
        try {
            // check cache if it got already added to the cache
            if (!dryMinioBinary.binaryCache.has(version)) {
                log(`download: Adding version ${version} to cache`)
                const downloader = new MinioBinaryDownload(options)
                dryMinioBinary.binaryCache.set(
                    version,
                    await downloader.getMinioPath()
                )
            }
        } finally {
            log("download: Removing Download lock")
            // remove lock
            await lock.unlock()
            log("download: Download lock removed")
        }

        const cachePath = dryMinioBinary.binaryCache.get(version)
        // ensure that "path" exists, so the return type does not change
        assertion(
            typeof cachePath === "string",
            new Error(
                `No Cache Path for version "${version}" found (and download failed silently?)`
            )
        )

        return cachePath
    }

    /**
     * Probe all supported paths for an binary and return the binary path
     * @param opts Options configuring which binary to search for
     * @throws {Error} if no valid BinaryPath has been found
     * @returns The first found BinaryPath
     */
    async getPath(opts = {}) {
        log("getPath")

        // "||" is still used here, because it should default if the value is false-y (like an empty string)
        const options = {
            ...(await dryMinioBinary.generateOptions(opts)),
            platform:
                opts.platform ||
                resolveConfig(ResolveConfigVariables.PLATFORM) ||
                os.platform(),
            checkMD5:
                opts.checkMD5 ||
                envToBool(resolveConfig(ResolveConfigVariables.MD5_CHECK))
        }

        log(`getPath: MinioBinary options:`, JSON.stringify(options, null, 2))

        let binaryPath = await dryMinioBinary.locateBinary(options)

        // check if the system binary has the same version as requested
        if (!!options.systemBinary) {
            // this case should actually never be false, because if "SYSTEM_BINARY" is set, "locateBinary" will run "getSystemPath" which tests the path for permissions
            if (!isNullOrUndefined(binaryPath)) {
                log(`getPath: Spawning binaryPath "${binaryPath}" to get version`)
                const spawnOutput = spawnSync(binaryPath, ["--version"])
                    .stdout.toString()
                    // this regex is to match the first line of the "mongod --version" output "db version v4.0.25" OR "db version v4.2.19-11-ge2f2736"
                    .match(
                        /^\s*db\s+version\s+v?(\d+\.\d+\.\d+)(-\d*)?(-[a-zA-Z0-9].*)?\s*$/im
                    )

                assertion(
                    !isNullOrUndefined(spawnOutput),
                    new Error("Could not find an version from system binary output!")
                )

                // dont warn if the versions dont match if "SYSTEM_BINARY_VERSION_CHECK" is false, but still test the binary if it is available to be executed
                if (
                    envToBool(
                        resolveConfig(ResolveConfigVariables.SYSTEM_BINARY_VERSION_CHECK)
                    )
                ) {
                    log("getPath: Checking & Warning about version conflicts")
                    const binaryVersion = spawnOutput[1]

                    if (semver.neq(options.version, binaryVersion)) {
                        // we will log the version number of the system binary and the version requested so the user can see the difference
                        console.warn(
                            "getPath: MinioTestServer: Possible version conflict\n" +
                            `  SystemBinary version: "${binaryVersion}"\n` +
                            `  Requested version:    "${options.version}"\n\n` +
                            "  Using SystemBinary!"
                        )
                    }
                }
            } else {
                throw new Error(
                    'Option "SYSTEM_BINARY" was set, but binaryPath was empty! (system binary could not be found?) [This Error should normally not be thrown, please report this]'
                )
            }
        }

        assertion(
            typeof options.version === "string",
            new Error('"MinioBinary.options.version" is not an string!')
        )

        if (!binaryPath) {
            if (envToBool(resolveConfig(ResolveConfigVariables.RUNTIME_DOWNLOAD))) {
                log('getPath: "RUNTIME_DOWNLOAD" is "true", trying to download')
                binaryPath = await this.download(options)
            } else {
                log('getPath: "RUNTIME_DOWNLOAD" is "false", not downloading')
            }
        }

        if (!binaryPath) {
            const runtimeDownload = envToBool(
                resolveConfig(ResolveConfigVariables.RUNTIME_DOWNLOAD)
            )
            throw new Error(
                `MinioBinary.getPath: could not find an valid binary path! (Got: "${binaryPath}", RUNTIME_DOWNLOAD: "${runtimeDownload}")`
            )
        }

        log(`getPath: Minio binary path: "${binaryPath}"`)

        return binaryPath
    }
}

module.exports = {
    MinioBinary
}

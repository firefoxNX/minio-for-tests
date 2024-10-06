const debug = require('debug');
const {
    DEFAULT_VERSION,
    envToBool,
    resolveConfig,
    ResolveConfigVariables
} = require("./resolveConfig")
const {
    assertion,
    checkBinaryPermissions,
    isNullOrUndefined,
    pathExists
} = require("./utils")
const path = require("path")
const {arch, homedir, platform} = require("os")
const findCacheDir = require("find-cache-dir")
const {getOS, isLinuxOS} = require("./getos")
const {
    NoRegexMatchError,
    NoSystemBinaryFoundError,
    ParseArchiveRegexError
} = require("./errors")
const {MinioBinaryDownloadUrl} = require("./MinioBinaryDownloadUrl")

const log = debug("MinioTST:DryMinioBinary")

/**
 * Locate a Binary, without downloading / locking
 */
class DryMinioBinary {
    /**
     * Binaries already found, values are: [Version, Path]
     */
    binaryCache = new Map()

    /**
     * Try to locate an existing binary
     * @returns The Path to an Binary Found, or undefined
     */
    async locateBinary(opts) {
        log(`locateBinary: Trying to locate Binary for version "${opts.version}"`)
        const useOpts = await this.generateOptions(opts)

        if (!!useOpts.systemBinary) {
            log(
                `locateBinary: env "SYSTEM_BINARY" was provided with value: "${useOpts.systemBinary}"`
            )

            const systemReturn = await this.getSystemPath(useOpts.systemBinary)

            if (isNullOrUndefined(systemReturn)) {
                throw new NoSystemBinaryFoundError(useOpts.systemBinary)
            }

            return systemReturn
        }

        if (this.binaryCache.has(opts.version)) {
            const binary = this.binaryCache.get(opts.version)
            log(
                `locateBinary: Requested Version found in cache: "[${opts.version}, ${binary}]"`
            )

            return binary
        }

        log("locateBinary: running generateDownloadPath")
        const returnValue = await this.generateDownloadPath(useOpts)

        if (!returnValue[0]) {
            log("locateBinary: could not find a existing binary")

            return undefined
        }

        log(`locateBinary: found binary at "${returnValue[1]}"`)
        this.binaryCache.set(opts.version, returnValue[1])

        return returnValue[1]
    }

    /**
     * Generate All required options for the binary name / path generation
     */
    async generateOptions(opts) {
        log("generateOptions")
        const defaultVersion =
            resolveConfig(ResolveConfigVariables.VERSION) ?? DEFAULT_VERSION
        const ensuredOpts = isNullOrUndefined(opts)
            ? {version: defaultVersion}
            : opts

        const final = {
            version: ensuredOpts.version || defaultVersion,
            downloadDir:
                resolveConfig(ResolveConfigVariables.DOWNLOAD_DIR) ||
                ensuredOpts.downloadDir ||
                "",
            os: ensuredOpts.os ?? (await getOS()),
            platform: ensuredOpts.platform || platform(),
            arch: ensuredOpts.arch || arch(),
            systemBinary:
                resolveConfig(ResolveConfigVariables.SYSTEM_BINARY) ||
                ensuredOpts.systemBinary ||
                ""
        }

        final.downloadDir = path.dirname(
            (await this.generateDownloadPath(final))[1]
        )

        // if truthy
        if (
            resolveConfig(ResolveConfigVariables.ARCHIVE_NAME) ||
            resolveConfig(ResolveConfigVariables.DOWNLOAD_URL)
        ) {
            // "DOWNLOAD_URL" will be used over "ARCHIVE_NAME"
            // the "as string" cast is there because it is already checked that one of the 2 exists, and "resolveConfig" ensures it only returns strings
            const input =
                resolveConfig(ResolveConfigVariables.DOWNLOAD_URL) ||
                resolveConfig(ResolveConfigVariables.ARCHIVE_NAME)

            log(
                `generateOptions: ARCHIVE_NAME or DOWNLOAD_URL defined, generating options based on that (input: "${input}")`
            )

            return this.parseArchiveNameRegex(input, final)
        }

        return final
    }

    /**
     * Parse "input" into DryMinioBinaryOptions
     * @param input The Input to be parsed with the regex
     * @param opts The Options which will be augmented with "input"
     * @returns The Augmented options
     */
    parseArchiveNameRegex(input, opts) {
        log(`parseArchiveNameRegex (input: "${input}")`)

        const archiveMatches = /minio-(?<platform>linux|win32|osx|macos)(?:-ssl-|-)(?<arch>\w{4,})(?:-(?<dist>\w+)|)(?:-ssl-|-)(?:v|)(?<version>[\d.]+(?:-latest|))\./gim.exec(
            input
        )

        assertion(
            !isNullOrUndefined(archiveMatches),
            new NoRegexMatchError("input")
        )

        // this error is kinda impossible to test, because the regex we use either has matches that are groups or no matches
        assertion(
            !isNullOrUndefined(archiveMatches.groups),
            new NoRegexMatchError("input", "groups")
        )

        const groups = archiveMatches.groups

        assertion(
            typeof groups.version === "string" && groups.version.length > 1,
            new ParseArchiveRegexError("version")
        )
        // the following 2 assertions are hard to test, because the regex has restrictions that are more strict than the assertions
        assertion(
            typeof groups.platform === "string" && groups.platform.length > 1,
            new ParseArchiveRegexError("platform")
        )
        assertion(
            typeof groups.arch === "string" && groups.arch.length >= 4,
            new ParseArchiveRegexError("arch")
        )

        opts.version = groups.version
        opts.arch = groups.arch

        if (groups.platform === "linux") {
            const distMatches = !!groups.dist
                ? /([a-z]+)(\d*)/gim.exec(groups.dist)
                : null

            opts.os = {
                os: "linux",
                dist: typeof distMatches?.[1] === "string" ? distMatches[1] : "unknown",
                // "release" should be able to be discarded in this case
                release: ""
            }
        } else {
            opts.os = {
                os: groups.platform
            }
        }

        return opts
    }

    /**
     * Get the full path with filename
     * @returns Absoulte Path with FileName
     */
    async getBinaryName(opts) {
        log("getBinaryName")

        let binaryName

        if (
            envToBool(
                resolveConfig(ResolveConfigVariables.USE_ARCHIVE_NAME_FOR_BINARY_NAME)
            )
        ) {
            const archiveName = await new MinioBinaryDownloadUrl(
                opts
            ).getArchiveName()
            binaryName = path.parse(archiveName).name
        } else {
            const addExe = opts.platform === "win32" ? ".exe" : ""
            const dist = isLinuxOS(opts.os) ? opts.os.dist : opts.os.os

            binaryName = `mongod-${opts.arch}-${dist}-${opts.version}${addExe}`
        }

        return binaryName
    }

    /**
     * Combine basePath with binaryName
     */
    combineBinaryName(basePath, binaryName) {
        log("combineBinaryName")

        return path.resolve(basePath, binaryName)
    }

    /**
     * Probe if the provided "systemBinary" is an existing path
     * @param systemBinary The Path to probe for an System-Binary
     * @returns System Binary path or undefined
     */
    async getSystemPath(systemBinary) {
        // REFACTOR: change this function to always return "string"
        log("getSystempath")
        try {
            await checkBinaryPermissions(systemBinary)

            log(`getSystemPath: found system binary path at "${systemBinary}"`)

            return systemBinary // returns if "access" is successful
        } catch (err) {
            log(
                `getSystemPath: can't find system binary at "${systemBinary}".\n${
                    err instanceof Error ? err.message : err
                }`
            )
        }

        return undefined
    }

    /**
     * Generate an "MongoBinaryPaths" object
     *
     * This Function should not hit the FileSystem
     * @returns an finished "MongoBinaryPaths" object
     */
    async generatePaths(opts) {
        log("generatePaths", opts)
        const final = {
            legacyHomeCache: "",
            modulesCache: "",
            relative: "",
            resolveConfig: ""
        }
        const binaryName = await this.getBinaryName(opts)
        // Assign "node_modules/.cache" to modulesCache

        // if we're in postinstall script, npm will set the cwd too deep
        // when in postinstall, npm will provide an "INIT_CWD" env variable
        let nodeModulesDLDir = process.env["INIT_CWD"] || process.cwd()
        // as long as "node_modules/minio-test-server*" is included in the path, go the paths up
        while (
            nodeModulesDLDir.includes(`node_modules${path.sep}minio-test-server`)
            ) {
            nodeModulesDLDir = path.resolve(nodeModulesDLDir, "..", "..")
        }

        const tmpModulesCache = findCacheDir({
            name: "minio-test-server",
            cwd: nodeModulesDLDir
        })

        if (!isNullOrUndefined(tmpModulesCache)) {
            final.modulesCache = this.combineBinaryName(
                path.resolve(tmpModulesCache),
                binaryName
            )
        }

        const legacyHomeCache = path.resolve(
            this.homedir(),
            ".cache/minio-binaries"
        )

        final.legacyHomeCache = this.combineBinaryName(legacyHomeCache, binaryName)

        // Resolve the config value "DOWNLOAD_DIR" if provided, otherwise remove = require(list
        const resolveConfigValue =
            opts.downloadDir || resolveConfig(ResolveConfigVariables.DOWNLOAD_DIR)

        if (
            !isNullOrUndefined(resolveConfigValue) &&
            resolveConfigValue.length > 0
        ) {
            log(`generatePaths: resolveConfigValue is not empty`)
            final.resolveConfig = this.combineBinaryName(
                resolveConfigValue,
                binaryName
            )
        }

        // Resolve relative to cwd if no other has been found
        final.relative = this.combineBinaryName(
            path.resolve(process.cwd(), "minio-binaries"),
            binaryName
        )

        return final
    }

    /**
     * Generate the Path where an Binary will be located
     * @returns "boolean" indicating if the binary exists at the provided path, and "string" the path to use for the binary
     */
    async generateDownloadPath(opts) {
        const preferGlobal = envToBool(
            resolveConfig(ResolveConfigVariables.PREFER_GLOBAL_PATH)
        )
        log(
            `generateDownloadPath: Generating Download Path, preferGlobal: "${preferGlobal}"`
        )
        const paths = await this.generatePaths(opts)

        log("generateDownloadPath: Paths:", paths, opts.systemBinary)

        // SystemBinary will only be returned if defined and paths exists
        if (!!opts.systemBinary && (await pathExists(opts.systemBinary))) {
            const sysPath = await this.getSystemPath(opts.systemBinary)

            if (!isNullOrUndefined(sysPath)) {
                return [true, sysPath]
            }
        }

        // Section where paths are probed for an existing binary
        if (await pathExists(paths.resolveConfig)) {
            log(
                `generateDownloadPath: Found binary in resolveConfig (DOWNLOAD_DIR): "${paths.resolveConfig}"`
            )

            return [true, paths.resolveConfig]
        }
        if (await pathExists(paths.legacyHomeCache)) {
            log(
                `generateDownloadPath: Found binary in legacyHomeCache: "${paths.legacyHomeCache}"`
            )

            return [true, paths.legacyHomeCache]
        }
        if (await pathExists(paths.modulesCache)) {
            log(
                `generateDownloadPath: Found binary in modulesCache: "${paths.modulesCache}"`
            )

            return [true, paths.modulesCache]
        }
        if (await pathExists(paths.relative)) {
            log(`generateDownloadPath: Found binary in relative: "${paths.relative}"`)

            return [true, paths.relative]
        }

        // Section where binary path gets generated when no binary was found
        log(
            `generateDownloadPath: no existing binary for version "${opts.version}" was found`
        )

        if (paths.resolveConfig.length > 0) {
            log(
                `generateDownloadPath: using resolveConfig (DOWNLOAD_DIR) "${paths.resolveConfig}"`
            )

            return [false, paths.resolveConfig]
        }
        if (preferGlobal && !!paths.legacyHomeCache) {
            log(
                `generateDownloadPath: using global (preferGlobal) "${paths.legacyHomeCache}"`
            )

            return [false, paths.legacyHomeCache]
        }
        // this case may not happen, if somehow the cwd gets changed outside of "node_modules" reach
        if (paths.modulesCache.length > 0) {
            log(`generateDownloadPath: using modulesCache "${paths.modulesCache}"`)

            return [false, paths.modulesCache]
        }

        log(`generateDownloadPath: using relative "${paths.relative}"`)

        return [false, paths.relative]
    }

    /**
     * This function is used, because jest just dosnt want "os.homedir" to be mocked
     * if someone can find an way to actually mock this in an test, please change it
     */
    homedir() {
        return homedir()
    }
}

module.exports = {
    DryMinioBinary
}

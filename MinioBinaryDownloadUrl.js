const {getOS} = require("./getos");
const {resolveConfig, ResolveConfigVariables} = require("./resolveConfig");
const debug = require("debug");
const semver = require("semver");
const {isNullOrUndefined} = require("./utils");
const {URL} = require("url");
const {
    GenericMMSError,
    KnownVersionIncompatibilityError,
    UnknownArchitectureError,
    UnknownPlatformError,
    UnknownVersionError
} = require("./errors");
const {deprecate} = require("util");


const log = debug("MinioTST:MinioBinaryDownloadUrl")

/**
 * Download URL generator
 */
class MinioBinaryDownloadUrl {
    constructor(opts) {
        this.version = opts.version
        this.platform = this.translatePlatform(opts.platform)
        this.arch = this.translateArch(opts.arch, this.platform)
        this.os = opts.os
    }

    /**
     * Assemble the URL to download
     * Calls all the necessary functions to determine the URL
     */
    async getDownloadUrl() {
        const downloadUrl = resolveConfig(ResolveConfigVariables.DOWNLOAD_URL)

        if (downloadUrl) {
            log(`Using "${downloadUrl}" as the Download-URL`)

            const url = new URL(downloadUrl) // check if this is an valid url

            return url.toString()
        }

        // const archive = await this.getArchiveName()
        const archive = 'archive'
        log(`Using "${archive}" as the Archive String`)

        const mirror =
            resolveConfig(ResolveConfigVariables.DOWNLOAD_MIRROR) ??
            "https://dl.min.io/server/minio/release"
        log(`Using "${mirror}" as the mirror`)

        const url = new URL(mirror)

        // ensure that the "mirror" path ends with "/"
        if (!url.pathname.endsWith("/")) {
            url.pathname = url.pathname + "/"
        }

        // no extra "/" between "pathname" and "platform", because of the "if" statement above to ensure "url.pathname" to end with "/"
        url.pathname = `${url.pathname}${this.platform}-${this.arch}/${archive}/${this.version}`

        return url.toString()
    }

    /**
     * Get the archive
     */
    async getArchiveName() {
        const archive_name = resolveConfig(ResolveConfigVariables.ARCHIVE_NAME)

        // double-"!" to not include falsy values
        if (!!archive_name) {
            return archive_name
        }

        switch (this.platform) {
            case "osx":
                return this.getArchiveNameOsx()
            case "win32":
            case "windows":
                return this.getArchiveNameWin()
            case "linux":
                return this.getArchiveNameLinux()
            default:
                throw new UnknownPlatformError(this.platform)
        }
    }

    /**
     * Get the archive for Windows
     * (from: https://www.minio.org/dl/win32)
     */
    getArchiveNameWin() {
        let name = `minio-${this.platform}-${this.arch}`
        const coercedVersion = semver.coerce(this.version)

        if (!isNullOrUndefined(coercedVersion)) {
            if (semver.satisfies(coercedVersion, "4.2.x")) {
                name += "-2012plus"
            } else if (semver.lt(coercedVersion, "4.1.0")) {
                name += "-2008plus-ssl"
            }
        }

        name += `-${this.version}.zip`

        return name
    }

    /**
     * Get the archive for OSX (Mac)
     * (from: https://www.minio.org/dl/osx)
     */
    getArchiveNameOsx() {
        let name = `minio-osx`
        const coercedVersion = semver.coerce(this.version)

        if (
            !isNullOrUndefined(coercedVersion) &&
            semver.gte(coercedVersion, "3.2.0")
        ) {
            name += "-ssl"
        }
        if (
            isNullOrUndefined(coercedVersion) ||
            semver.gte(coercedVersion, "4.2.0")
        ) {
            name = `minio-macos` // somehow these files are not listed in https://www.minio.org/dl/osx
        }

        // minio has native arm64
        if (this.arch === "aarch64") {
            // force usage of "x86_64" binary for all versions below than 6.0.0
            if (
                !isNullOrUndefined(coercedVersion) &&
                semver.lt(coercedVersion, "6.0.0")
            ) {
                log(
                    'getArchiveNameOsx: Arch is "aarch64" and version is below 6.0.0, using x64 binary'
                )
                this.arch = "x86_64"
            } else {
                log(
                    'getArchiveNameOsx: Arch is "aarch64" and version is above or equal to 6.0.0, using arm64 binary'
                )
                // naming for macos is still "arm64" instead of "aarch64"
                this.arch = "arm64"
            }
        }

        name += `-${this.arch}-${this.version}.tgz`

        return name
    }

    /**
     * Get the archive for Linux
     * (from: https://www.minio.org/dl/linux)
     */
    async getArchiveNameLinux() {
        let osString

        // the highest version for "i686" seems to be 3.3
        if (this.arch !== "i686") {
            if (!this.os && resolveConfig(ResolveConfigVariables.DISTRO)) {
                this.os = await getOS()
            }

            if (resolveConfig(ResolveConfigVariables.DISTRO)) {
                this.overwriteDistro()
            }

            osString = this.getLinuxOSVersionString(this.os)
        }

        // this is below, to allow overwriting the arch (like arm64 to aarch64)
        let name = `minio-linux-${this.arch}`

        if (!!osString) {
            name += `-${osString}`
        }

        name += `-${this.version}.tgz`

        return name
    }

    /**
     * Parse and apply config option DISTRO
     */
    overwriteDistro() {
        const env = resolveConfig(ResolveConfigVariables.DISTRO)

        if (isNullOrUndefined(env)) {
            return
        }

        const split = env.split("-")

        const distro = split[0]
        const release = split[1]

        if (isNullOrUndefined(distro)) {
            throw new GenericMMSError(
                'Expected DISTRO option to have a distro like "ubuntu-18.04"'
            )
        }

        if (isNullOrUndefined(release)) {
            throw new GenericMMSError(
                'Expected DISTRO option to have a release like "ubuntu-18.04" (delimited by "-")'
            )
        }

        this.os = {
            os: "linux",
            dist: distro,
            release: release
        }
    }

    /**
     * Get the version string (with distro)
     * @param os LinuxOS Object
     */
    getLinuxOSVersionString(os) {
        if (regexHelper(/ubuntu/i, os)) {
            return this.getUbuntuVersionString(os)
        } else if (regexHelper(/amzn/i, os)) {
            return this.getAmazonVersionString(os)
        } else if (regexHelper(/suse/i, os)) {
            return this.getSuseVersionString(os)
            // handle "oracle linux"(ol) as "rhel", because they define "id_like: fedora", but the versions themself match up with rhel
        } else if (regexHelper(/(rhel|centos|scientific|^ol$)/i, os)) {
            return this.getRhelVersionString(os)
        } else if (regexHelper(/fedora/i, os)) {
            return this.getFedoraVersionString(os)
        } else if (regexHelper(/debian/i, os)) {
            return this.getDebianVersionString(os)
        } else if (regexHelper(/alpine/i, os)) {
            console.warn("There is no offical build of Minio for Alpine!")
            // Match "arch", "archlinux", "manjaro", "manjarolinux", "arco", "arcolinux"
        } else if (regexHelper(/(arch|manjaro|arco)(?:linux)?$/i, os)) {
            console.warn(
                `There is no official build of Minio for ArchLinux (${os.dist}). Falling back to Ubuntu 22.04 release.`
            )

            return this.getUbuntuVersionString({
                os: "linux",
                dist: "Ubuntu Linux",
                release: "22.04"
            })
        } else if (regexHelper(/gentoo/i, os)) {
            // it seems like debian binaries work for gentoo too (at least most), see https://github.com/nodkz/minio-memory-server/issues/639
            console.warn(
                `There is no official build of Minio for Gentoo (${os.dist}). Falling back to Debian.`
            )

            return this.getDebianVersionString({
                os: "linux",
                dist: "Debian",
                release: "11"
            })
        } else if (regexHelper(/unknown/i, os)) {
            // "unknown" is likely to happen if no release file / command could be found
            console.warn(
                "Couldnt parse dist information, please report this to https://github.com/nodkz/minio-memory-server/issues"
            )
        }

        // warn for the fallback
        console.warn(
            `Unknown/unsupported linux "${os.dist}(${os.id_like?.join(
                ", "
            )})". Falling back to legacy Minio build!`
        )

        return this.getLegacyVersionString()
    }

    /**
     * Get the version string for Debian
     * @param os LinuxOS Object
     */
    getDebianVersionString(os) {
        let name = "debian"
        const release = parseFloat(os.release)
        const coercedVersion = semver.coerce(this.version)

        if (isNullOrUndefined(coercedVersion)) {
            throw new UnknownVersionError(this.version)
        }

        // without any "release"(empty string), fallback to testing
        // see https://tracker.debian.org/news/1433360/accepted-base-files-13-source-into-unstable/
        const isTesting = ["unstable", "testing", ""].includes(os.release)

        if (isTesting || release >= 11) {
            // Debian 11 is compatible with the binaries for debian 10
            // but does not have binaries for before 5.0.8
            // and only set to use "debian10" if the requested version is not a latest version
            if (
                semver.lt(coercedVersion, "5.0.8") &&
                !testVersionIsLatest(this.version)
            ) {
                log(
                    "debian11 detected, but version below 5.0.8 requested, using debian10"
                )
                name += "10"
            } else {
                name += "11"
            }
        } else if (release >= 10) {
            name += "10"
        } else if (release >= 9) {
            name += "92"
        } else if (release >= 8.1) {
            name += "81"
        } else if (release >= 7.1) {
            name += "71"
        }

        if (isTesting || release >= 10) {
            if (
                semver.lt(coercedVersion, "4.2.1") &&
                !testVersionIsLatest(this.version)
            ) {
                throw new KnownVersionIncompatibilityError(
                    `Debian ${release || os.release || os.codename}`,
                    this.version,
                    ">=4.2.1",
                    "Mongodb does not provide binaries for versions before 4.2.1 for Debian 10+ and also cannot be mapped to a previous Debian release"
                )
            }
        }

        return name
    }

    /**
     * Get the version string for Fedora
     * @param os LinuxOS Object
     */
    getFedoraVersionString(os) {
        let name = "rhel"
        const fedoraVer = parseInt(os.release, 10)

        // 36 and onwards dont ship with libcrypto.so.1.1 anymore and need to be manually installed ("openssl1.1")
        // 34 onward dosnt have "compat-openssl10" anymore, and only build from 4.0.24 are available for "rhel80"
        if (fedoraVer >= 34) {
            name += "80"
        }
        if (fedoraVer < 34 && fedoraVer >= 19) {
            name += "70"
        }
        if (fedoraVer < 19 && fedoraVer >= 12) {
            name += "62"
        }
        if (fedoraVer < 12 && fedoraVer >= 6) {
            name += "55"
        }

        return name
    }

    /**
     * Get the version string for Red Hat Enterprise Linux
     * @param os LinuxOS Object
     */
    getRhelVersionString(os) {
        let name = "rhel"
        const {release} = os
        const releaseAsSemver = semver.coerce(release) // coerce "8" to "8.0.0" and "8.2" to "8.2.0", makes comparing easier than "parseInt" or "parseFloat"
        const coercedVersion = semver.coerce(this.version)

        if (isNullOrUndefined(coercedVersion)) {
            throw new UnknownVersionError(this.version)
        }

        if (releaseAsSemver) {
            if (this.arch === "aarch64") {
                // there are no versions for aarch64 before rhel 8.2 (or currently after)
                if (semver.lt(releaseAsSemver, "8.2.0")) {
                    throw new KnownVersionIncompatibilityError(
                        `Rhel ${release}`,
                        this.version,
                        ">=4.4.2",
                        "ARM64(aarch64) support for rhel is only for rhel82 or higher"
                    )
                }
                // there are no versions for aarch64 before minio 4.4.2
                // Note: version 4.4.2 and 4.4.3 are NOT listed at the list, but are existing; list: https://www.minio.com/download-center/community/releases/archive
                if (
                    semver.lt(coercedVersion, "4.4.2") &&
                    !testVersionIsLatest(this.version)
                ) {
                    throw new KnownVersionIncompatibilityError(
                        `Rhel ${release}`,
                        this.version,
                        ">=4.4.2"
                    )
                }

                if (!semver.eq(releaseAsSemver, "8.2.0")) {
                    log(
                        `a different rhel version than 8.2 is used: "${release}", using 82 release`
                    )
                }

                // rhel aarch64 support is only for rhel 8.2 (and no version after explicitly)
                name += "82"
            } else if (semver.satisfies(releaseAsSemver, ">=8.0.0")) {
                name += "80"
            } else if (semver.satisfies(releaseAsSemver, "^7.0.0")) {
                name += "70"
            } else if (semver.satisfies(releaseAsSemver, "^6.0.0")) {
                name += "62"
            } else if (semver.satisfies(releaseAsSemver, "^5.0.0")) {
                name += "55"
            } else {
                console.warn(`Unhandled RHEL version: "${release}"("${this.arch}")`)
            }
        } else {
            console.warn(`Couldnt coerce RHEL version "${release}"`)
        }
        // fallback if name has not been modified yet
        if (name === "rhel") {
            log('getRhelVersionString: falling back to "70"')
            // fallback to "70", because that is what currently is supporting 3.6 to 5.0 and should work with many
            name += "70"
        }

        return name
    }

    /**
     * Get the version string for Amazon Distro
     * @param os LinuxOS Object
     */
    getAmazonVersionString(os) {
        let name = "amazon"
        const release = parseInt(os.release, 10)

        if (release >= 2 && release <= 3) {
            name += "2"
        }
        // dont add anthing as fallback, because for "amazon 1", minio just uses "amazon"

        return name
    }

    /**
     * Linux Fallback
     */
    getLegacyVersionString() {
        return ""
    }

    /**
     * Get the version string for Suse / OpenSuse
     * @param os LinuxOS Object
     */
    // TODO: add tests for getSuseVersionString
    getSuseVersionString(os) {
        const releaseMatch = os.release.match(/(^11|^12|^15)/)

        return releaseMatch ? `suse${releaseMatch[0]}` : ""
    }

    /**
     * Get the version string for Ubuntu
     * @param os LinuxOS Object
     */
    getUbuntuVersionString(os) {
        let ubuntuOS = undefined
        const coercedVersion = semver.coerce(this.version)

        if (isNullOrUndefined(coercedVersion)) {
            throw new UnknownVersionError(this.version)
        }

        // "id_like" processing (version conversion) [this is an block to be collapsible]
        {
            if (/^linux\s?mint\s*$/i.test(os.dist)) {
                const mintToUbuntuRelease = {
                    17: "14.04",
                    18: "16.04",
                    19: "18.04",
                    20: "20.04"
                }

                ubuntuOS = {
                    os: "linux",
                    dist: "ubuntu",
                    release:
                        mintToUbuntuRelease[parseInt(os.release.split(".")[0])] ||
                        mintToUbuntuRelease[20]
                }
            }

            if (/^elementary(?:\s?os)?\s*$/i.test(os.dist)) {
                const elementaryToUbuntuRelease = {
                    3: "14.04",
                    4: "16.04",
                    5: "18.04",
                    6: "20.04"
                }

                // untangle elemenatary versioning from hell https://en.wikipedia.org/wiki/Elementary_OS#Development
                const [elementaryMajor, elementaryMinor] = os.release
                    .split(".")
                    .map(el => parseInt(el))
                const realMajor = elementaryMajor || elementaryMinor

                ubuntuOS = {
                    os: "linux",
                    dist: "ubuntu",
                    release:
                        elementaryToUbuntuRelease[realMajor] || elementaryToUbuntuRelease[6]
                }
            }
        }

        if (isNullOrUndefined(ubuntuOS)) {
            // Warn against distros that have a ID_LIKE set to "ubuntu", but no other upstream information and are not specially mapped (see above)
            if (!/^ubuntu(?:| linux)\s*$/i.test(os.dist)) {
                console.warn(
                    `Unmapped distro "${os.dist}" with ID_LIKE "ubuntu", defaulting to highest ubuntu version!\n` +
                    'This means that your distro does not have a internal mapping in MMS or does not have a upstream release file (like "/etc/upstream-release/lsb-release"), but has set a ID_LIKE'
                )

                ubuntuOS = {
                    os: "linux",
                    dist: "ubuntu",
                    release: "20.04" // TODO: try to keep this up-to-date to the latest LTS
                }
            } else {
                ubuntuOS = os
            }
        }

        const ubuntuYear = parseInt(ubuntuOS.release.split(".")[0], 10)

        if (this.arch === "aarch64") {
            // this is because, before version 4.1.10, everything for "arm64" / "aarch64" were just "arm64" and for "ubuntu1604"
            if (semver.satisfies(coercedVersion, "<4.1.10")) {
                this.arch = "arm64"

                return "ubuntu1604"
            }
            // this is because versions below "4.4.0" did not provide an binary for anything above 1804
            if (semver.satisfies(coercedVersion, ">=4.1.10 <4.4.0")) {
                return "ubuntu1804"
            }
        }

        if (ubuntuOS.release === "14.10") {
            return "ubuntu1410-clang"
        }

        // there are no MongoDB 3.x binary distributions for ubuntu >= 18
        // https://www.minio.org/dl/linux/x86_64-ubuntu1604
        if (ubuntuYear >= 18 && semver.satisfies(coercedVersion, "3.x.x")) {
            log(
                `getUbuntuVersionString: ubuntuYear is "${ubuntuYear}", which dosnt have an 3.x.x version, defaulting to "1604"`
            )

            return "ubuntu1604"
        }

        // there are no MongoDB <=4.3.x binary distributions for ubuntu > 18
        // https://www.minio.org/dl/linux/x86_64-ubuntu1804
        if (ubuntuYear > 18 && semver.satisfies(coercedVersion, "<=4.3.x")) {
            log(
                `getUbuntuVersionString: ubuntuYear is "${ubuntuYear}", which dosnt have an "<=4.3.x" version, defaulting to "1804"`
            )

            return "ubuntu1804"
        }

        // there are only binaries for 2204 since 6.0.4 (and not binaries for ubuntu2104)
        if (ubuntuYear >= 21 && semver.satisfies(coercedVersion, "<6.0.4")) {
            return "ubuntu2004"
        }

        // TODO: change or remove "14" default, since it no-longer is supported above 4.0
        // the "04" version always exists for ubuntu, use that as default
        return `ubuntu${ubuntuYear || 14}04`
    }

    /**
     * Translate input platform to minio-archive useable platform
     * @param platform The Platform to translate to a minio archive platform
     * @example
     * darwin -> osx
     */
    translatePlatform(platform) {
        switch (platform) {
            case "darwin":
                return "darwin"
            case "win32":
                const version = semver.coerce(this.version)

                if (isNullOrUndefined(version)) {
                    return "windows"
                }

                return semver.gte(version, "4.3.0") ? "windows" : "win32"
            case "linux":
            case "elementary OS":
                return "linux"
            case "sunos":
                deprecate(
                    () => {
                    },
                    "minio-memory-server will fully drop support for sunos in 9.0",
                    "MMS002"
                )()

                return "sunos5"
            default:
                throw new UnknownPlatformError(platform)
        }
    }

    /**
     * Translate input arch to minio-archive useable arch
     * @param arch The Architecture to translate to a minio archive architecture
     * @param minioPlatform The minio-archive platform
     * @example
     * x64 -> x86_64
     */
    translateArch(arch, minioPlatform) {
        switch (arch) {
            case "ia32":
                deprecate(
                    () => {
                    },
                    "minio-test-server will fully drop support for ia32 in 9.0",
                    "MMS001"
                )()

                if (minioPlatform === "linux") {
                    return "i686"
                } else if (minioPlatform === "win32") {
                    return "i386"
                }

                throw new UnknownArchitectureError(arch, minioPlatform)
            case "x86_64":
                case "amd64":
            case "x64":
                return "amd64"
            case "arm64":
                return "arm64"
            case "aarch64":
                return "aarch64"
            default:
                throw new UnknownArchitectureError(arch)
        }
    }
}

/**
 * Helper function to reduce code / regex duplication
 */
function regexHelper(regex, os) {
    return (
        regex.test(os.dist) ||
        (!isNullOrUndefined(os.id_like)
            ? os.id_like.filter(v => regex.test(v)).length >= 1
            : false)
    )
}

/** Helper to consistently test if a version is a "-latest" version, like "v5.0-latest" */
function testVersionIsLatest(version) {
    return /^v\d+\.\d+-latest$/.test(version)
}

module.exports = {
    MinioBinaryDownloadUrl
}

const { platform } = require("os")
const debug = require("debug")
const { isNullOrUndefined, tryReleaseFile } = require("./utils")

const log = debug("MinioTST:getos")

/** Collection of Regexes for "lsb_release -a" parsing */
const LSBRegex = {
    // regex format is "lsb_release" (command output) and then "lsb-release" (file output)
    name: /^(?:distributor id:|DISTRIB_ID=)\s*(.*)$/im,
    codename: /^(?:codename:|DISTRIB_CODENAME=)\s*(.*)$/im,
    release: /^(?:release:|DISTRIB_RELEASE=)\s*(.*)$/im
}

/** Collection of Regexes for "/etc/os-release" parsing */
const OSRegex = {
    name: /^id\s*=\s*"?(\w*)"?$/im,
    codename: /^version_codename\s*=\s*(.*)$/im,
    release: /^version_id\s*=\s*"?(\d*(?:\.\d*)?)"?$/im,
    id_like: /^id_like\s*=\s*"?([\w\s]*)"?$/im
}

/** Helper Static so that a consistent UNKNOWN value is used */
const UNKNOWN = "unknown"

/**
 * Check if the OS is a LinuxOS Typeguard
 * @param os The OS object to check for
 */
function isLinuxOS(os) {
    return os.os === "linux"
}

/**
 * Cache the "getOS" call, so that not much has to be re-executed over and over
 */
let cachedOs

/** Get an OS object */
async function getOS() {
    if (!cachedOs) {
        /** Node builtin function for first determinations */
        const osName = platform()

        // Linux is a special case.
        if (osName === "linux") {
            cachedOs = await getLinuxInformation()
        } else {
            cachedOs = { os: osName }
        }
    }

    return cachedOs
}

/** Function to outsource Linux Information Parsing */
async function getLinuxInformation() {
    // Structure of this function:
    // 1. get upstream release, if possible
    // 2. get os release (etc) because it has an "id_like"
    // 3. get os release (usr) because it has an "id_like"
    // 4. get lsb-release (etc) as fallback

    const upstreamLSB = await tryReleaseFile(
        "/etc/upstream-release/lsb-release",
        parseLSB
    )

    if (isValidOs(upstreamLSB)) {
        log("getLinuxInformation: Using UpstreamLSB")

        return upstreamLSB
    }

    const etcOsRelease = await tryReleaseFile("/etc/os-release", parseOS)

    if (isValidOs(etcOsRelease)) {
        log("getLinuxInformation: Using etcOsRelease")

        return etcOsRelease
    }

    const usrOsRelease = await tryReleaseFile("/usr/lib/os-release", parseOS)

    if (isValidOs(usrOsRelease)) {
        log("getLinuxInformation: Using usrOsRelease")

        return usrOsRelease
    }

    const etcLSBRelease = await tryReleaseFile("/etc/lsb-release", parseLSB)

    if (isValidOs(etcLSBRelease)) {
        log("getLinuxInformation: Using etcLSBRelease")

        return etcLSBRelease
    }

    console.warn(
        "Could not find any valid Release File, using fallback information"
    )

    // if none has worked, return unknown
    return {
        os: "linux",
        dist: UNKNOWN,
        release: ""
    }
}

/**
 * Helper function to check if the input os is valid
 * @param os The OS information to check
 * @returns `true` if not undefined AND not UNKNOWN
 */
function isValidOs(os) {
    // helper for debugging
    if (os && os.dist === UNKNOWN) {
        log("isValidOS: found defined os, but was unknown:", os)
    }

    return !isNullOrUndefined(os) && os.dist !== UNKNOWN
}

/**
 * Parse LSB-like output (either command or file)
 */
function parseLSB(input) {
    return {
        os: "linux",
        dist: input.match(LSBRegex.name)?.[1].toLocaleLowerCase() ?? UNKNOWN,
        codename: input.match(LSBRegex.codename)?.[1].toLocaleLowerCase(),
        release: input.match(LSBRegex.release)?.[1].toLocaleLowerCase() ?? ""
    }
}

/**
 * Parse OSRelease-like output
 */
function parseOS(input) {
    return {
        os: "linux",
        dist: input.match(OSRegex.name)?.[1].toLocaleLowerCase() ?? UNKNOWN,
        codename: input.match(OSRegex.codename)?.[1].toLocaleLowerCase(),
        release: input.match(OSRegex.release)?.[1].toLocaleLowerCase() ?? "",
        id_like: input
            .match(OSRegex.id_like)?.[1]
            .toLocaleLowerCase()
            .split(" ")
    }
}

module.exports = {
    getOS,
    isLinuxOS

}

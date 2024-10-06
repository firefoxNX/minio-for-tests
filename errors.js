/**
 * Because since node 4.0.0 the internal util.is* functions got deprecated
 * @param val Any value to test if null or undefined
 */
function isNullOrUndefined(val) {
    return val === null || val === undefined
}

class StateError extends Error {
    constructor(wantedStates, gotState) {
        super(
            `Incorrect State for operation: "${gotState}", allowed States: "[${wantedStates.join(
                ","
            )}]"\n` +
            "This may be because of using a v6.x way of calling functions, look at the following guide if anything applies:\n" +
            "https://nodkz.github.io/mongodb-memory-server/docs/guides/migration/migrate7#no-function-other-than-start-create-ensureinstance-will-be-starting-anything"
        )
        this.wantedStates = wantedStates
        this.gotState = gotState
    }
}

class UnknownLockfileStatusError extends Error {
    constructor(status) {
        super(`Unknown LockFile Status: "${status}"`)
        this.status = status
    }
}

class UnableToUnlockLockfileError extends Error {
    constructor(thisInstance, file) {
        super(
            `Cannot unlock file "${file}", because it is not locked by this ${
                thisInstance ? "instance" : "process"
            }`
        )
        this.thisInstance = thisInstance
        this.file = file
    }
}

class UnknownPlatformError extends Error {
    constructor(platform) {
        super(`Unknown Platform: "${platform}"`)
        this.platform = platform
    }
}

class UnknownArchitectureError extends Error {
    constructor(arch, platform) {
        super()

        this.arch = arch
        this.platform = platform

        if (!isNullOrUndefined(platform)) {
            this.message = `Unsupported Architecture-Platform combination: arch: "${arch}", platform: "${platform}"`
        } else {
            this.message = `Unsupported Architecture: "${arch}"`
        }
    }
}

class WaitForPrimaryTimeoutError extends Error {
    constructor(timeout, where) {
        super(
            `Timed out after ${timeout}ms while waiting for a Primary (where: "${where}")`
        )
        this.timeout = timeout
        this.where = where
    }
}

// REFACTOR: consider merging this with InstanceInfoError
class EnsureInstanceError extends Error {
    constructor(isRunning) {
        super()
        this.isRunning = isRunning
        const baseMesasge = '"ensureInstance" failed, because'

        if (isRunning) {
            this.message = `${baseMesasge} state was "running" but "instanceInfo" was undefined!`
        } else {
            this.message = `${baseMesasge} "instanceInfo" was undefined after running "start"`
        }
    }
}

// REFACTOR: merge this error with BinaryNotFoundError
class NoSystemBinaryFoundError extends Error {
    constructor(binaryPath) {
        super(
            `Config option "SYSTEM_BINARY" was provided with value "${binaryPath}", but no binary could be found!`
        )
        this.binaryPath = binaryPath
    }
}

class Md5CheckFailedError extends Error {
    constructor(binarymd5, checkfilemd5) {
        super(
            `MD5 check failed! Binary MD5 is "${binarymd5}", Checkfile MD5 is "${checkfilemd5}"`
        )
        this.binarymd5 = binarymd5
        this.checkfilemd5 = checkfilemd5
    }
}

class StartBinaryFailedError extends Error {
    constructor(binary) {
        super(`Starting the Binary Failed (PID is undefined)! Binary: "${binary}"`)
        this.binary = binary
    }
}

class InstanceInfoError extends Error {
    constructor(where) {
        super(
            `"instanceInfo" was undefined when expected to be defined! (where: "${where}")`
        )
        this.where = where
    }
}

class KeyFileMissingError extends Error {
    constructor() {
        super(`"keyfileLocation" was undefined when expected!`)
    }
}

class AuthNotObjectError extends Error {
    constructor() {
        super('"auth" was not a object when it was expected!')
    }
}

class InsufficientPermissionsError extends Error {
    constructor(path) {
        super(
            `File "${path}" does not have the required Permissions, required Permissions: "--x"`
        )
        this.path = path
    }
}

class BinaryNotFoundError extends Error {
    constructor(path) {
        super(`No Binary at path "${path}" was found! (ENOENT)`)
        this.path = path
    }
}

/**
 * Custom Fallback Error for "utils.assertion", it is a named/custom Error to confuse less in the stacktrace
 */
class AssertionFallbackError extends Error {
    constructor() {
        super("Assert failed - no custom error")
    }
}

class ReplsetCountLowError extends Error {
    constructor(count) {
        super(
            `ReplSet Count needs to be 1 or higher! (specified count: "${count}")`
        )
        this.count = count
    }
}

class ParseArchiveRegexError extends Error {
    constructor(key) {
        super(`Expected "${key}" to be found in regex groups`)
        this.key = key
    }
}

class NoRegexMatchError extends Error {
    constructor(name, extra) {
        super()
        this.name = name
        this.extra = extra
        const addExtra = !!extra ? `(${extra})` : ""
        this.message = `Expected "${name}" to have Regex Matches${addExtra}`
    }
}

class KnownVersionIncompatibilityError extends Error {
    constructor(dist, requested_version, available_versions, extra) {
        super()

        this.dist = dist
        this.requested_version = requested_version
        this.available_versions = available_versions
        this.extra = extra

        const addExtra = !!extra ? `\n${extra}` : ""
        this.message = `Requested Version "${requested_version}" is not available for "${dist}"! Available Versions: "${available_versions}"${addExtra}`
    }
}

/**
 * Basic Error wrapper for "instanceError" events from "stdoutHandler"
 */
class StdoutInstanceError extends Error {
    // not using "public variable: type", because it is a basic wrapper for "Error"
    constructor(msg) {
        super(msg)
    }
}

/**
 * Error for when the instance closes with non-0 (or non-12) codes or signals
 */
class UnexpectedCloseError extends Error {
    constructor(code, signal) {
        super()

        this.message = `Instance closed unexpectedly with code "${code}" and signal "${signal}"`

        if (signal == "SIGILL") {
            this.message +=
                "\nThe Process Exited with SIGILL, which mean illegal instruction, which is commonly thrown in mongodb 5.0+ when not having AVX available on the CPU"
        }

        if (process.platform === "win32" && (code ?? 0) > 1000000000) {
            this.message +=
                "\nExit Code is large, commonly meaning that vc_redist is not installed, the latest vc_redist can be found at https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170"
        }
    }
}

/**
 * Error for when VERSION fails to coerce to a semver version but is required
 */
class UnknownVersionError extends Error {
    constructor(version) {
        super(
            `Could not corece VERSION to a semver version (version: "${version}")`
        )
        this.version = version
    }
}

/**
 * Error for when downloading fails
 */
class DownloadError extends Error {
    constructor(url, msg) {
        super(`Download failed for url \"${url}\", Details:\n${msg}`)
        this.url = url
        this.msg = msg
    }
}

/* Custom Generic Error class for MMS */
class GenericMMSError extends Error {}

module.exports = {
    StateError,
    UnknownLockfileStatusError,
    UnableToUnlockLockfileError,
    UnknownPlatformError,
    UnknownArchitectureError,
    WaitForPrimaryTimeoutError,
    EnsureInstanceError,
    NoSystemBinaryFoundError,
    Md5CheckFailedError,
    StartBinaryFailedError,
    InstanceInfoError,
    KeyFileMissingError,
    AuthNotObjectError,
    InsufficientPermissionsError,
    BinaryNotFoundError,
    AssertionFallbackError,
    ReplsetCountLowError,
    ParseArchiveRegexError,
    NoRegexMatchError,
    KnownVersionIncompatibilityError,
    StdoutInstanceError,
    UnexpectedCloseError,
    UnknownVersionError,
    DownloadError,
    GenericMMSError
}

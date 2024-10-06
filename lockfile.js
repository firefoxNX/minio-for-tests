const {EventEmitter} = require("events");
const utils = require("./utils");
const debug = require("debug");
const path = require("path");
const {promises: fspromises} = require("fs");
const {Mutex} = require("async-mutex");
const {v4: uuidv4} = require("uuid");
const {
    UnableToUnlockLockfileError,
    UnknownLockfileStatusError
} = require("./errors");


const log = debug("MinioTST:LockFile")

/**
 * Error used to cause an promise to stop and re-wait for an lockfile
 */
class RepeatError extends Error {
    constructor(repeat) {
        super()
        this.repeat = repeat
    }
}

let LockFileStatus

;(function (LockFileStatus) {
    LockFileStatus[(LockFileStatus["available"] = 0)] = "available"
    LockFileStatus[(LockFileStatus["availableInstance"] = 1)] =
        "availableInstance"
    LockFileStatus[(LockFileStatus["lockedSelf"] = 2)] = "lockedSelf"
    LockFileStatus[(LockFileStatus["lockedDifferent"] = 3)] = "lockedDifferent"
})(LockFileStatus || (LockFileStatus = {}))

let LockFileEvents

;(function (LockFileEvents) {
    LockFileEvents["lock"] = "lock"
    LockFileEvents["unlock"] = "unlock"
})(LockFileEvents || (LockFileEvents = {}))

/** Dummy class for types */
class LockFileEventsClass extends EventEmitter {
}

class LockFile {
    /** All Files that are handled by this process */
    files = new Set()
    /** Listen for events from this process */
    events = new LockFileEventsClass()
    /** Mutex to stop same-process race conditions */
    mutex = new Mutex()

    /**
     * Acquire an lockfile
     * @param file The file to use as the LockFile
     */
    async lock(file) {
        await utils.ensureAsync()
        log(`lock: Locking file "${file}"`)

        const useFile = path.resolve(file.trim())

        // just to make sure "path" could resolve it to something
        utils.assertion(
            useFile.length > 0,
            new Error("Provided Path for lock file is length of 0")
        )

        const status = await this.checkLock(useFile)
        switch (status) {
            case LockFileStatus.lockedDifferent:
            case LockFileStatus.lockedSelf:
                return this.waitForLock(useFile)
            case LockFileStatus.available:
                this.lockFile = this.createLock(useFile)
                return this.lockFile
            default:
                throw new UnknownLockfileStatusError(status)
        }
    }

    /**
     * Check the status of the lockfile
     * @param file The file to use as the LockFile
     */
    async checkLock(file, uuid) {
        log(`checkLock: for file "${file}" with uuid: "${uuid}"`)

        // if file / path does not exist, directly acquire lock
        if (!(await utils.pathExists(file))) {
            return LockFileStatus.available
        }

        try {
            const fileData = (await fspromises.readFile(file))
                .toString()
                .trim()
                .split(" ")
            const readout = parseInt(fileData[0])

            if (readout === process.pid) {
                log(
                    `checkLock: Lock File Already exists, and is for *this* process, with uuid: "${fileData[1]}"`
                )

                // early return if "file"(input) dosnt exists within the files Map anymore
                if (!this.files.has(file)) {
                    return LockFileStatus.available
                }

                // check if "uuid"(input) matches the filereadout, if yes say "available" (for unlock check)
                if (!utils.isNullOrUndefined(uuid)) {
                    return uuid === fileData[1]
                        ? LockFileStatus.availableInstance
                        : LockFileStatus.lockedSelf
                }

                // as fallback say "lockedSelf"
                return LockFileStatus.lockedSelf
            }

            log(
                `checkLock: Lock File Aready exists, for a different process: "${readout}"`
            )

            return utils.isAlive(readout)
                ? LockFileStatus.lockedDifferent
                : LockFileStatus.available
        } catch (err) {
            if (utils.errorWithCode(err) && err.code === "ENOENT") {
                log("checkLock: reading file failed with ENOENT")

                return LockFileStatus.available
            }

            throw err
        }
    }

    /**
     * Wait for the Lock file to become available
     * @param file The file to use as the LockFile
     */
    async waitForLock(file) {
        log(`waitForLock: Starting to wait for file "${file}"`)
        /** Store the interval id to be cleared later */
        let interval = undefined
        /** Store the function in an value to be cleared later, without having to use an class-external or class function */
        let eventCB = undefined
        await new Promise(res => {
            eventCB = unlockedFile => {
                if (unlockedFile === file) {
                    res()
                }
            }

            interval = setInterval(async () => {
                const lockStatus = await this.checkLock(file)
                log(
                    `waitForLock: Interval for file "${file}" with status "${lockStatus}"`
                )

                if (lockStatus === LockFileStatus.available) {
                    res()
                }
            }, 1000 * 3) // every 3 seconds

            this.events.on(LockFileEvents.unlock, eventCB)
        })

        if (interval) {
            clearInterval(interval)
        }
        if (eventCB) {
            this.events.removeListener(LockFileEvents.unlock, eventCB)
        }

        log(`waitForLock: File became available "${file}"`)

        // i hope the following prevents race-conditions
        await utils.ensureAsync() // to make sure all event listeners got executed
        const lockStatus = await this.checkLock(file)
        log(
            `waitForLock: Lock File Status reassessment for file "${file}": ${lockStatus}`
        )

        switch (lockStatus) {
            case LockFileStatus.lockedDifferent:
            case LockFileStatus.lockedSelf:
                return this.waitForLock(file)
            case LockFileStatus.available:
                return this.createLock(file)
            default:
                throw new UnknownLockfileStatusError(lockStatus)
        }
    }

    /**
     * Function create the path and lock file
     * @param file The file to use as the LockFile
     */
    async createLock(file) {
        // this function only gets called by processed "file" input, so no re-checking
        log(`createLock: trying to create a lock file for "${file}"`)
        const uuid = uuidv4()

        // This is not an ".catch" because in an callback running "return" dosnt "return" the parent function
        try {
            await this.mutex.runExclusive(async () => {
                // this may cause "Stack Size" errors, because of an infinite loop if too many times this gets called
                if (this.files.has(file)) {
                    log(`createLock: Map already has file "${file}"`)

                    throw new RepeatError(true)
                }

                await utils.mkdir(path.dirname(file))

                await fspromises.writeFile(file, `${process.pid.toString()} ${uuid}`)

                this.files.add(file)
                this.events.emit(LockFileEvents.lock, file)
            })
        } catch (err) {
            if (err instanceof RepeatError && err.repeat) {
                return this.waitForLock(file)
            }
        }

        log(`createLock: Lock File Created for file "${file}"`)

        return new LockFile(file, uuid)
    }

    constructor(file, uuid) {
        this.file = file
        this.uuid = uuid
    }

    /**
     * Unlock the File that is locked by this instance
     */
    async unlock() {
        await utils.ensureAsync()
        log(`unlock: Unlocking file "${this.file}"`)

        if (utils.isNullOrUndefined(this.file) || this.file?.length <= 0) {
            log("unlock: invalid file, returning")

            return
        }

        // No "case-fallthrough" because this is more clear (and no linter will complain)
        switch (await this.checkLock(this.file, this.uuid)) {
            case LockFileStatus.available:
                log(
                    `unlock: Lock Status was already "available" for file "${this.file}"`
                )
                await this.unlockCleanup(false)

                return
            case LockFileStatus.availableInstance:
                log(
                    `unlock: Lock Status was "availableInstance" for file "${this.file}"`
                )
                await this.unlockCleanup(true)

                return
            case LockFileStatus.lockedSelf:
                throw new UnableToUnlockLockfileError(true, this.file)
            default:
                throw new UnableToUnlockLockfileError(false, this.file)
        }
    }

    /**
     * Helper function for the unlock-cleanup
     * @param fileio Unlink the file?
     */
    async unlockCleanup(fileio = true) {
        return await this.mutex.runExclusive(async () => {
            log(`unlockCleanup: for file "${this.file}"`)

            if (utils.isNullOrUndefined(this.file)) {
                return
            }

            if (fileio) {
                await fspromises.unlink(this.file).catch(reason => {
                    log(`unlockCleanup: lock file unlink failed: "${reason}"`)
                })
            }

            this.files.delete(this.file)
            this.events.emit(LockFileEvents.unlock, this.file)

            // make this LockFile instance unusable (to prevent double unlock calling)
            this.file = undefined
            this.uuid = undefined
        })
    }
}

module.exports = {
    LockFile,
    LockFileEvents,
    LockFileStatus
}

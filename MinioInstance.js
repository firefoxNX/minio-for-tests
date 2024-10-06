const { fork, spawn } = require("child_process");
const path = require("path");
const { MinioBinary } = require("./MinioBinary");
const minioBinary = new MinioBinary();
const debug = require("debug");
const {
    assertion,
    isNullOrUndefined,
    killProcess,
    checkBinaryPermissions
} = require("./utils");
const { lt } = require("semver");
const { EventEmitter } = require("events");

const {
    GenericMMSError,
    StartBinaryFailedError,
    StdoutInstanceError,
    UnexpectedCloseError
} = require("./errors");

// ignore the nodejs warning for coverage
/* istanbul ignore next */
if (lt(process.version, "12.22.0")) {
    console.warn("Using NodeJS below 12.22.0")
}

const log = debug("MinioTST:MinioInstance")

let MinioInstanceEvents

;(function(MinioInstanceEvents) {
    MinioInstanceEvents["instanceReplState"] = "instanceReplState"
    MinioInstanceEvents["instancePrimary"] = "instancePrimary"
    MinioInstanceEvents["instanceReady"] = "instanceReady"
    MinioInstanceEvents["instanceSTDOUT"] = "instanceSTDOUT"
    MinioInstanceEvents["instanceSTDERR"] = "instanceSTDERR"
    MinioInstanceEvents["instanceClosed"] = "instanceClosed"
    MinioInstanceEvents["instanceRawError"] = "instanceRawError"
    MinioInstanceEvents["instanceError"] = "instanceError"
    MinioInstanceEvents["killerLaunched"] = "killerLaunched"
    MinioInstanceEvents["instanceLaunched"] = "instanceLaunched"
    MinioInstanceEvents["instanceStarted"] = "instanceStarted"
})(MinioInstanceEvents || (MinioInstanceEvents = {}))

/**
 * Minio Instance Handler Class
 * This Class starts & stops the "minio" process directly and handles stdout, sterr and close events
 */
class MinioInstance extends EventEmitter {
    /**
     * This boolean is "true" if the instance is elected to be PRIMARY
     */
    isInstancePrimary = false
    /**
     * This boolean is "true" if the instance is successfully started
     */
    isInstanceReady = false

    constructor(opts) {
        super()
        this.instanceOpts = { ...opts.instance }
        this.binaryOpts = { ...opts.binary }
        this.spawnOpts = { ...opts.spawn }

        this.on(MinioInstanceEvents.instanceReady, () => {
            this.isInstanceReady = true
            this.debug("constructor: Instance is ready!")
        })

        this.on(MinioInstanceEvents.instanceError, async err => {
            this.debug(`constructor: Instance has thrown an Error: ${err.toString()}`)
            this.isInstanceReady = false
            this.isInstancePrimary = false

            await this.stop()
        })
    }

    /**
     * Debug-log with template applied
     * @param msg The Message to log
     */
    debug(msg, ...extra) {
        const port = this.instanceOpts.port ?? "unknown"
        log(`Minio[${port}]: ${msg}`, ...extra)
    }

    /**
     * Create an new instance an call method "start"
     * @param opts Options passed to the new instance
     */
    async create(opts) {
        log("create: Called .create() method")
        const instance = new MinioInstance(opts)
        await instance.start()

        return instance
    }

    /**
     * Create an array of arguments for the minio instance
     */
    prepareCommandArgs() {
        this.debug("prepareCommandArgs")
        assertion(
            !isNullOrUndefined(this.instanceOpts.port),
            new Error('"instanceOpts.port" is required to be set!')
        )
        assertion(
            !isNullOrUndefined(this.instanceOpts.dataPath),
            new Error('"instanceOpts.dataPath" is required to be set!')
        )

        const result = []

        // result.push("--port", this.instanceOpts.port.toString())
        result.push("server", this.instanceOpts.dataPath)

        // "!!" converts the value to an boolean (double-invert) so that no "falsy" values are added

        const final = result.concat(this.instanceOpts.args ?? [])

        this.debug(
            "prepareCommandArgs: final argument array:" + JSON.stringify(final)
        )

        return final
    }

    /**
     * Create the minio process
     * @fires MinioInstance#instanceStarted
     */
    async start() {
        this.debug("start")
        this.isInstancePrimary = false
        this.isInstanceReady = false

        let timeout

        const minioBin = await minioBinary.getPath(this.binaryOpts)
        await checkBinaryPermissions(minioBin)

        const launch = new Promise((res, rej) => {
            this.once(MinioInstanceEvents.instanceReady, res)
            this.once(MinioInstanceEvents.instanceError, rej)
            this.once(
                MinioInstanceEvents.instanceClosed,
                function launchInstanceClosed() {
                    rej(
                        new Error(
                            "Instance Exited before being ready and without throwing an error!"
                        )
                    )
                }
            )

            // extra conditions just to be sure that the custom defined timeout is valid
            const timeoutTime =
                !!this.instanceOpts.launchTimeout &&
                this.instanceOpts.launchTimeout >= 1000
                    ? this.instanceOpts.launchTimeout
                    : 1000 * 10 // default 10 seconds

            timeout = setTimeout(() => {
                const err = new GenericMMSError(
                    `Instance failed to start within ${timeoutTime}ms`
                )
                this.emit(MinioInstanceEvents.instanceError, err)

                rej(err)
            }, timeoutTime)
        }).finally(() => {
            // always clear the timeout after the promise somehow resolves
            clearTimeout(timeout)
        })

        this.debug("start: Starting Processes")
        this.minioProcess = this._launchMinio(minioBin)
        // This assertion is here because somewhere between nodejs 12 and 16 the types for "childprocess.pid" changed to include "| undefined"
        // it is tested and a error is thrown in "this_launchMinio", but typescript somehow does not see this yet as of 4.3.5
        assertion(
            !isNullOrUndefined(this.minioProcess.pid),
            new Error("Minio Process failed to spawn")
        )
        this.killerProcess = this._launchKiller(process.pid, this.minioProcess.pid)

        await launch
        this.emit(MinioInstanceEvents.instanceStarted)
        this.debug("start: Processes Started")
    }

    /**
     * Shutdown all related processes (Minio Instance & Killer Process)
     */
    async stop() {
        this.debug("stop")

        if (!this.minioProcess && !this.killerProcess) {
            this.debug("stop: nothing to shutdown, returning")

            return false
        }

        if (!isNullOrUndefined(this.minioProcess)) {
            // try to run "shutdown" before running "killProcess" (gracefull "SIGINT")
            // using this, otherwise on windows nodejs will handle "SIGINT" & "SIGTERM" & "SIGKILL" the same (instant exit)

            await killProcess(
                this.minioProcess,
                "minioProcess",
                this.instanceOpts.port
            )
            this.minioProcess = undefined // reset reference to the childProcess for "minio"
        } else {
            this.debug("stop: minioProcess: nothing to shutdown, skipping")
        }
        if (!isNullOrUndefined(this.killerProcess)) {
            await killProcess(
                this.killerProcess,
                "killerProcess",
                this.instanceOpts.port
            )
            this.killerProcess = undefined // reset reference to the childProcess for "minio_killer"
        } else {
            this.debug("stop: killerProcess: nothing to shutdown, skipping")
        }

        this.debug("stop: Instance Finished Shutdown")

        return true
    }

    /**
     * Actually launch minio
     * @param minioBin The binary to run
     * @fires MinioInstance#instanceLaunched
     */
    _launchMinio(minioBin) {
        this.debug("_launchMinio: Launching Minio Process")
        const childProcess = spawn(
            path.resolve(minioBin),
            this.prepareCommandArgs(),
            {
                ...this.spawnOpts,
                stdio: "pipe" // ensure that stdio is always an pipe, regardless of user input
            }
        )
        childProcess.stderr?.on("data", this.stderrHandler.bind(this))
        childProcess.stdout?.on("data", this.stdoutHandler.bind(this))
        childProcess.on("close", this.closeHandler.bind(this))
        childProcess.on("error", this.errorHandler.bind(this))

        if (isNullOrUndefined(childProcess.pid)) {
            throw new StartBinaryFailedError(path.resolve(minioBin))
        }

        this.emit(MinioInstanceEvents.instanceLaunched)

        return childProcess
    }

    /**
     * Spawn an seperate process to kill the parent and the minio instance to ensure "minio" gets stopped in any case
     * @param parentPid Parent nodejs process
     * @param childPid Minio process to kill
     * @fires MinioInstance#killerLaunched
     */
    _launchKiller(parentPid, childPid) {
        this.debug(
            `_launchKiller: Launching Killer Process (parent: ${parentPid}, child: ${childPid})`
        )
        // spawn process which kills itself and minio process if current process is dead
        const killer = fork(
            path.resolve(__dirname, "./minio_killer.js"),
            [parentPid.toString(), childPid.toString()],
            {
                detached: true,
                stdio: "ignore" // stdio cannot be done with an detached process cross-systems and without killing the fork on parent termination
            }
        )

        killer.unref() // dont force an exit on the fork when parent is exiting

        this.emit(MinioInstanceEvents.killerLaunched)

        return killer
    }

    /**
     * Event "error" handler
     * @param err The Error to handle
     * @fires MinioInstance#instanceRawError
     * @fires MinioInstance#instanceError
     */
    errorHandler(err) {
        this.emit(MinioInstanceEvents.instanceRawError, err)
        this.emit(MinioInstanceEvents.instanceError, err)
    }

    /**
     * Write the CLOSE event to the debug function
     * @param code The Exit code to handle
     * @param signal The Signal to handle
     * @fires MinioInstance#instanceClosed
     */
    closeHandler(code, signal) {
        // check if the platform is windows, if yes check if the code is not "12" or "0" otherwise just check code is not "0"
        // because for mongodb any event on windows (like SIGINT / SIGTERM) will result in an code 12
        // https://docs.mongodb.com/manual/reference/exit-codes/#12
        if (
            (process.platform === "win32" && code !== 12 && code !== 0) ||
            (process.platform !== "win32" && code !== 0)
        ) {
            this.debug(
                "closeHandler: Minio instance closed with an non-0 (or non 12 on windows) code!"
            )
            // Note: this also emits when a signal is present, which is expected because signals are not expected here
            this.emit(
                MinioInstanceEvents.instanceError,
                new UnexpectedCloseError(code, signal)
            )
        }

        this.debug(`closeHandler: code: "${code}", signal: "${signal}"`)
        this.emit(MinioInstanceEvents.instanceClosed, code, signal)
    }

    /**
     * Write STDERR to debug function
     * @param message The STDERR line to write
     * @fires MinioInstance#instanceSTDERR
     */
    stderrHandler(message) {
        const line = message.toString().trim()
        this.debug(`stderrHandler: ""${line}""`) // denoting the STDERR string with double quotes, because the stdout might also use quotes
        this.emit(MinioInstanceEvents.instanceSTDERR, line)

        this.checkErrorInLine(line)

        if(/MinIO Object Storage Server/i.test(line)) {
            this.emit(MinioInstanceEvents.instanceReady)
        }
    }

    /**
     * Write STDOUT to debug function and process some special messages
     * @param message The STDOUT line to write/parse
     * @fires MinioInstance#instanceSTDOUT
     * @fires MinioInstance#instanceReady
     * @fires MinioInstance#instanceError
     * @fires MinioInstance#instancePrimary
     * @fires MinioInstance#instanceReplState
     */
    stdoutHandler(message) {
        const line = message.toString().trim() // trimming to remove extra new lines and spaces around the message
        this.debug(`stdoutHandler: ""${line}""`) // denoting the STDOUT string with double quotes, because the stdout might also use quotes
        this.emit(MinioInstanceEvents.instanceSTDOUT, line)

        // dont use "else if", because input can be multiple lines and match multiple things
        if (/waiting for connections/i.test(line)) {
            this.emit(MinioInstanceEvents.instanceReady)
        }

        this.checkErrorInLine(line)

        // this case needs to be infront of "transition to primary complete", otherwise it might reset "isInstancePrimary" to "false"
        if (/transition to \w+ from \w+/i.test(line)) {
            const state = /transition to (\w+) from \w+/i.exec(line)?.[1] ?? "UNKNOWN"
            this.emit(MinioInstanceEvents.instanceReplState, state)

            if (state !== "PRIMARY") {
                this.isInstancePrimary = false
            }
        }
        if (
            /transition to primary complete; database writes are now permitted/i.test(
                line
            )
        ) {
            this.isInstancePrimary = true
            this.debug('stdoutHandler: emitting "instancePrimary"')
            this.emit(MinioInstanceEvents.instancePrimary)
        }
    }

    /**
     * Run Checks on the line if the lines contain any thrown errors
     * @param line The Line to check
     */
    checkErrorInLine(line) {
        if (/address already in use/i.test(line)) {
            this.emit(
                MinioInstanceEvents.instanceError,
                new StdoutInstanceError(
                    `Port "${this.instanceOpts.port}" already in use`
                )
            )
        }

        {
            const execptionMatch = /\bexception in initAndListen: (\w+): /i.exec(line)

            if (!isNullOrUndefined(execptionMatch)) {
                // in pre-4.0 mongodb this exception may have been "permission denied" and "Data directory /path not found"

                this.emit(
                    MinioInstanceEvents.instanceError,
                    new StdoutInstanceError(
                        `Instance Failed to start with "${execptionMatch[1] ??
                        "unknown"}". Original Error:\n` +
                        line
                            .substring(execptionMatch.index + execptionMatch[0].length)
                            .replace(/, terminating$/gi, "")
                    )
                )
            }

            // special handling for when mongodb outputs this error as json
            const execptionMatchJson = /\bDBException in initAndListen,/i.test(line)

            if (execptionMatchJson) {
                const loadedJSON = JSON.parse(line) ?? {}

                this.emit(
                    MinioInstanceEvents.instanceError,
                    new StdoutInstanceError( // try to use the parsed json, but as fallback use the entire line
                        `Instance Failed to start with "DBException in initAndListen". Original Error:\n` +
                        loadedJSON?.attr?.error ?? line
                    )
                )
            }
        }

        if (/CURL_OPENSSL_3['\s]+not found/i.test(line)) {
            this.emit(
                MinioInstanceEvents.instanceError,
                new StdoutInstanceError(
                    "libcurl3 is not available on your system. Minio requires it and cannot be started without it.\n" +
                    "You should manually install libcurl3 or try to use an newer version of Minio"
                )
            )
        }
        if (/CURL_OPENSSL_4['\s]+not found/i.test(line)) {
            this.emit(
                MinioInstanceEvents.instanceError,
                new StdoutInstanceError(
                    "libcurl4 is not available on your system. Minio requires it and cannot be started without it.\n" +
                    "You need to manually install libcurl4"
                )
            )
        }

        {
            /*
            The following regex matches something like "libsomething.so.1: cannot open shared object"
            and is optimized to only start matching at a word boundary ("\b") and using atomic-group replacement "(?=inner)\1"
            */
            const liberrormatch = line.match(
                /\b(?=(lib[^:]+))\1: cannot open shared object/i
            )

            if (!isNullOrUndefined(liberrormatch)) {
                const lib = liberrormatch[1].toLocaleLowerCase() ?? "unknown"
                this.emit(
                    MinioInstanceEvents.instanceError,
                    new StdoutInstanceError(
                        `Instance failed to start because a library is missing or cannot be opened: "${lib}"`
                    )
                )
            }
        }

        if (/\*\*\*aborting after/i.test(line)) {
            this.emit(
                MinioInstanceEvents.instanceError,
                new StdoutInstanceError("Minio internal error")
            )
        }
    }
}

module.exports = {
    MinioInstance,
    MinioInstanceEvents
}

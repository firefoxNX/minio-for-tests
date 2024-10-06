const getPort = require("get-port");
const {
    assertion,
    generateDbName,
    uriTemplate,
    isNullOrUndefined,
    authDefault,
    statPath,
    createTmpDir,
    removeDir
} = require("./utils");
const {MinioInstance} = require("./MinioInstance");
const debug = require("debug");
const {EventEmitter} = require("events");
const {promises: fspromises} = require("fs");
const Minio = require('minio');
const {EnsureInstanceError, StateError} = require("./errors");
const os = require("os");


const log = debug("MinioTST:MinioServer")

/**
 * All Events for "MinioServer"
 */
let MinioServerEvents

;(function (MinioServerEvents) {
    MinioServerEvents["stateChange"] = "stateChange"
})(MinioServerEvents || (MinioServerEvents = {}))

/**
 * All States for "MinioServer._state"
 */
let MinioServerStates

;(function (MinioServerStates) {
    MinioServerStates["new"] = "new"
    MinioServerStates["starting"] = "starting"
    MinioServerStates["running"] = "running"
    MinioServerStates["stopped"] = "stopped"
})(MinioServerStates || (MinioServerStates = {}))

class MinioServer extends EventEmitter {
    /**
     * The Current State of this instance
     */
    _state = MinioServerStates.new

    /**
     * Create a Minio-Test-Server Instance
     * @param opts Minio-Test-Server Options
     */
    constructor(opts) {
        super()
        this.opts = {...opts}

        // TODO: consider changing this to not be set if "instance.auth" is false in 9.0
        if (!isNullOrUndefined(this.opts.auth)) {
            // assign defaults
            this.auth = authDefault(this.opts.auth)
        }
    }

    /**
     * Create a Minio-Test-Server Instance that can be awaited
     * @param opts Minio-Test-Server Options
     */
    async create(opts) {
        log("create: Called .create() method")
        const instance = new MinioServer({...opts})
        await instance.start()

        return instance
    }

    /**
     * Start the Minio Instance
     * @param forceSamePort Force to use the Same Port, if already an "instanceInfo" exists
     * @throws if state is not "new" or "stopped"
     */
    async start(forceSamePort = false) {
        this.debug("start: Called .start() method")

        switch (this._state) {
            case MinioServerStates.new:
            case MinioServerStates.stopped:
                break
            case MinioServerStates.running:
                break
            case MinioServerStates.starting:
            default:
                throw new StateError(
                    [MinioServerStates.new, MinioServerStates.stopped],
                    this.state
                )
        }

        assertion(
            isNullOrUndefined(this._instanceInfo?.instance.minioProcess),
            new Error(
                'Cannot start because "instance.minioProcess" is already defined!'
            )
        )

        this.stateChange(MinioServerStates.starting)

        await this._startUpInstance(forceSamePort).catch(async err => {
            // add error information on macos-arm because "spawn Unknown system error -86" does not say much
            if (
                err instanceof Error &&
                err.message?.includes("spawn Unknown system error -86")
            ) {
                if (os.platform() === "darwin" && os.arch() === "arm64") {
                    err.message += err.message +=
                        ", Is Rosetta Installed and Setup correctly?"
                }
            }

            if (!debug.enabled("MinioTST:MinioServer")) {
                console.warn(
                    "Starting the MinioServer Instance failed, enable debug log for more information. Error:\n",
                    err
                )
            }

            this.debug("_startUpInstance threw a Error: ", err)

            await this.stop({doCleanup: false, force: false}) // still try to close the instance that was spawned, without cleanup for investigation

            this.stateChange(MinioServerStates.stopped)

            throw err
        })

        this.stateChange(MinioServerStates.running)
        this.debug("start: Instance fully Started")
    }

    /**
     * Change "this._state" to "newState" and emit "stateChange" with "newState"
     * @param newState The new State to set & emit
     */
    stateChange(newState) {
        this._state = newState
        this.emit(MinioServerEvents.stateChange, newState)
    }

    /**
     * Debug-log with template applied
     * @param msg The Message to log
     */
    debug(msg, ...extra) {
        const port = this._instanceInfo?.port ?? "unknown"
        log(`Minio[${port}]: ${msg}`, ...extra)
    }

    /**
     * Find a new unlocked port
     * @param port A User defined default port
     */
    async getNewPort(port) {
        const newPort = await getPort({port})

        // only log this message if a custom port was provided
        if (port != newPort && typeof port === "number") {
            this.debug(
                `getNewPort: starting with port "${newPort}", since "${port}" was locked`
            )
        }

        return newPort
    }

    /**
     * Construct Instance Starting Options
     */
    async getStartOptions(forceSamePort = false) {
        this.debug(`getStartOptions: forceSamePort: ${forceSamePort}`)
        /** Shortcut to this.opts.instance */
        const instOpts = this.opts.instance ?? {}
        /**
         * This variable is used for determining if "createAuth" should be run
         */
        let isNew = true

        // use pre-defined port if available, otherwise generate a new port
        let port = typeof instOpts.port === "number" ? instOpts.port : undefined

        // if "forceSamePort" is not true, and get a available port
        if (!forceSamePort || isNullOrUndefined(port)) {
            port = await this.getNewPort(port)
        }

        // consider directly using "this.opts.instance", to pass through all options, even if not defined in "StartupInstanceData"
        const data = {
            port: port,
            // dbName: generateDbName(instOpts.dbName),
            dataPath: instOpts.dataPath,
            ip: instOpts.ip ?? "127.0.0.1",
            tmpDir: undefined,
            keyfileLocation: instOpts.keyfileLocation,
            launchTimeout: instOpts.launchTimeout
        }

        if (isNullOrUndefined(this._instanceInfo)) {
            // create a tmpDir instance if no "dataPath" is given
            if (!data.dataPath) {
                data.tmpDir = await createTmpDir("minio-tst-")
                data.dataPath = data.tmpDir

                isNew = true // just to ensure "isNew" is "true" because a new temporary directory got created
            } else {
                this.debug(
                    `getStartOptions: Checking if "${data.dataPath}}" (no new tmpDir) already has data`
                )
                const files = await fspromises.readdir(data.dataPath)

                isNew = files.length === 0 // if there are no files in the directory, assume that the database is new
            }
        } else {
            isNew = false
        }

        const enableAuth =
            (typeof instOpts.auth === "boolean" ? instOpts.auth : true) && // check if auth is even meant to be enabled
            this.authObjectEnable()

        const createAuth =
            enableAuth && // re-use all the checks from "enableAuth"
            !isNullOrUndefined(this.auth) && // needs to be re-checked because typescript complains
            (this.auth.force || isNew) // check that either "isNew" or "this.auth.force" is "true"

        return {
            data: data,
            createAuth: createAuth,
            minioOptions: {
                instance: {
                    ...data,
                    args: instOpts.args,
                    auth: enableAuth
                },
                binary: this.opts.binary,
                spawn: this.opts.spawn
            }
        }
    }

    /**
     * Internal Function to start an instance
     * @param forceSamePort Force to use the Same Port, if already an "instanceInfo" exists
     * @private
     */
    async _startUpInstance(forceSamePort = false) {
        this.debug(
            "_startUpInstance: Called MinioServer._startUpInstance() method"
        )

        if (!isNullOrUndefined(this._instanceInfo)) {
            this.debug(
                '_startUpInstance: "instanceInfo" already defined, reusing instance'
            )

            if (!forceSamePort) {
                const newPort = await this.getNewPort(this._instanceInfo.port)
                this._instanceInfo.instance.instanceOpts.port = newPort
                this._instanceInfo.port = newPort
            }

            await this._instanceInfo.instance.start()

            return
        }

        const {minioOptions, createAuth, data} = await this.getStartOptions(
            forceSamePort
        )
        this.debug(
            `_startUpInstance: Creating new Minio instance with options:`,
            minioOptions
        )

        const minioInstance = new MinioInstance(minioOptions);
        const instance = await minioInstance.create(minioOptions)
        this.debug(
            `_startUpInstance: Instance Started, createAuth: "${createAuth}"`
        )

        this._instanceInfo = {
            ...data,
            instance
        }

        // always set the "extraConnectionOptions" when "auth" is enabled, regardless of if "createAuth" gets run
        if (
            this.authObjectEnable() &&
            minioOptions.instance?.auth === true &&
            !isNullOrUndefined(this.auth) // extra check again for typescript, because it cant reuse checks from "enableAuth" yet
        ) {
            instance.extraConnectionOptions = {
                authSource: "admin",
                authMechanism: "SCRAM-SHA-256",
                auth: {
                    username: this.auth.customRootName,
                    password: this.auth.customRootPwd
                }
            }
        }

        // "isNullOrUndefined" because otherwise typescript complains about "this.auth" possibly being not defined
        if (!isNullOrUndefined(this.auth) && createAuth) {
            this.debug(
                `_startUpInstance: Running "createAuth" (force: "${this.auth.force}")`
            )
            // await this.createAuth(data)
        } else {
            // extra "if" to log when "disable" is set to "true"
            if (this.opts.auth?.disable) {
                this.debug(
                    '_startUpInstance: AutomaticAuth.disable is set to "true" skipping "createAuth"'
                )
            }
        }
    }

    async stop(cleanupOptions) {
        this.debug("stop: Called .stop() method")

        /** Default to cleanup temporary, but not custom dataPaths */
        let cleanup = {doCleanup: true, force: false}

        // handle the old way of setting wheter to cleanup or not
        // TODO: for next major release (9.0), this should be removed
        if (typeof cleanupOptions === "boolean") {
            cleanup.doCleanup = cleanupOptions
        }

        // handle the new way of setting what and how to cleanup
        if (typeof cleanupOptions === "object") {
            cleanup = cleanupOptions
        }

        // just return "true" if there was never an instance
        if (isNullOrUndefined(this._instanceInfo)) {
            this.debug('stop: "instanceInfo" is not defined (never ran?)')

            return false
        }

        if (this._state === MinioServerStates.stopped) {
            this.debug('stop: state is "stopped", trying to stop / kill anyway')
        }

        this.debug(
            // "undefined" would say more than ""
            `stop: Stopping Minio server on port ${this._instanceInfo.port} with pid ${this._instanceInfo.instance?.minioProcess?.pid}`
        )
        await this._instanceInfo.instance.stop()

        this.stateChange(MinioServerStates.stopped)

        if (cleanup.doCleanup) {
            await this.cleanup(cleanup)
        }

        return true
    }

    async cleanup(options) {
        assertionIsMMSState(MinioServerStates.stopped, this.state)

        /** Default to doing cleanup, but not forcing it */
        let cleanup = {doCleanup: true, force: false}

        // handle the old way of setting wheter to cleanup or not
        // TODO: for next major release (9.0), this should be removed
        if (typeof options === "boolean") {
            cleanup.force = options
        }

        // handle the new way of setting what and how to cleanup
        if (typeof options === "object") {
            cleanup = options
        }

        this.debug(`cleanup:`, cleanup)

        // dont do cleanup, if "doCleanup" is false
        if (!cleanup.doCleanup) {
            this.debug('cleanup: "doCleanup" is set to false')

            return
        }

        if (isNullOrUndefined(this._instanceInfo)) {
            this.debug('cleanup: "instanceInfo" is undefined')

            return
        }

        assertion(
            isNullOrUndefined(this._instanceInfo.instance.minioProcess),
            new Error(
                'Cannot cleanup because "instance.minioProcess" is still defined'
            )
        )

        const tmpDir = this._instanceInfo.tmpDir

        if (!isNullOrUndefined(tmpDir)) {
            this.debug(`cleanup: removing tmpDir at ${tmpDir}`)
            await removeDir(tmpDir)
        }

        if (cleanup.force) {
            const dataPath = this._instanceInfo.dataPath
            const res = await statPath(dataPath)

            if (isNullOrUndefined(res)) {
                this.debug(
                    `cleanup: force is true, but path "${dataPath}" dosnt exist anymore`
                )
            } else {
                assertion(
                    res.isDirectory(),
                    new Error("Defined dataPath is not a directory")
                )

                await removeDir(dataPath)
            }
        }

        this.stateChange(MinioServerStates.new) // reset "state" to new, because the dataPath got removed
        this._instanceInfo = undefined
    }

    /**
     * Get Information about the currently running instance, if it is not running it returns "undefined"
     */
    get instanceInfo() {
        return this._instanceInfo
    }

    /**
     * Get Current state of this class
     */
    get state() {
        return this._state
    }

    /**
     * Ensure that the instance is running
     * -> throws if instance cannot be started
     */
    async ensureInstance() {
        this.debug("ensureInstance: Called .ensureInstance() method")

        switch (this._state) {
            case MinioServerStates.running:
                if (this._instanceInfo) {
                    return this._instanceInfo
                }

                throw new EnsureInstanceError(true)
            case MinioServerStates.new:
            case MinioServerStates.stopped:
                break
            case MinioServerStates.starting:
                return new Promise((res, rej) =>
                    this.once(MinioServerEvents.stateChange, state => {
                        if (state != MinioServerStates.running) {
                            rej(
                                new Error(
                                    `"ensureInstance" waited for "running" but got a different state: "${state}"`
                                )
                            )

                            return
                        }

                        // this assertion is mainly for types (typescript otherwise would complain that "_instanceInfo" might be "undefined")
                        assertion(
                            !isNullOrUndefined(this._instanceInfo),
                            new Error("InstanceInfo is undefined!")
                        )

                        res(this._instanceInfo)
                    })
                )
            default:
                throw new StateError(
                    [
                        MinioServerStates.running,
                        MinioServerStates.new,
                        MinioServerStates.stopped,
                        MinioServerStates.starting
                    ],
                    this.state
                )
        }

        this.debug('ensureInstance: no running instance, calling "start()" command')
        await this.start()
        this.debug('ensureInstance: "start()" command was succesfully resolved')

        // check again for 1. Typescript-type reasons and 2. if .start failed to throw an error
        if (!this._instanceInfo) {
            throw new EnsureInstanceError(false)
        }

        return this._instanceInfo
    }

    /**
     * Generate the Connection string used by mongodb
     * @param otherDb add a database into the uri (in mongodb its the auth database, in mongoose its the default database for models)
     * @param otherIp change the ip in the generated uri, default will otherwise always be "127.0.0.1"
     * @throws if state is not "running" (or "starting")
     * @throws if a server doesnt have "instanceInfo.port" defined
     * @returns a valid mongo URI, by the definition of https://docs.mongodb.com/manual/reference/connection-string/
     */
    getUri(otherDb, otherIp) {
        this.debug("getUri:", this.state, otherDb, otherIp)

        switch (this.state) {
            case MinioServerStates.running:
            case MinioServerStates.starting:
                break
            case MinioServerStates.stopped:
            default:
                throw new StateError(
                    [MinioServerStates.running, MinioServerStates.starting],
                    this.state
                )
        }

        assertionInstanceInfo(this._instanceInfo)

        return uriTemplate(
            otherIp || "127.0.0.1",
            this._instanceInfo.port,
            generateDbName(otherDb)
        )
    }

    /**
     * Helper function to determine if the "auth" object is set and not to be disabled
     * This function expectes to be run after the auth object has been transformed to a object
     * @returns "true" when "auth" should be enabled
     */
    authObjectEnable() {
        if (isNullOrUndefined(this.auth)) {
            return false
        }

        return typeof this.auth.disable === "boolean" // if "this._replSetOpts.auth.disable" is defined, use that
            ? !this.auth.disable // invert the disable boolean, because "auth" should only be disabled if "disabled = true"
            : true // if "this._replSetOpts.auth.disable" is not defined, default to true because "this._replSetOpts.auth" is defined
    }
}

/**
 * This function is to de-duplicate code
 * -> this couldnt be included in the class, because "asserts this.instanceInfo" is not allowed
 * @param val this.instanceInfo
 */
function assertionInstanceInfo(val) {
    assertion(!isNullOrUndefined(val), new Error('"instanceInfo" is undefined'))
}

/**
 * Helper function to de-duplicate state checking for "MinioServerStates"
 * @param wantedState The State that is wanted
 * @param currentState The current State ("this._state")
 */
function assertionIsMMSState(wantedState, currentState) {
    assertion(
        currentState === wantedState,
        new StateError([wantedState], currentState)
    )
}

module.exports = {
    MinioServer,
    MinioServerStates,
    MinioServerEvents
}

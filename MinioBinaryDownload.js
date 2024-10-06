const os = require("os");
const {URL} = require("url");
const path = require("path");
const {
    promises: fspromises,
    createWriteStream,
    createReadStream,
    constants
} = require("fs");
const md5File = require("md5-file");
const {https} = require("follow-redirects");
const {createUnzip} = require("zlib");
const tar = require("tar-stream");
const yauzl = require("yauzl");
const {MinioBinaryDownloadUrl} = require("./MinioBinaryDownloadUrl");
const {HttpsProxyAgent} = require("https-proxy-agent");
const {
    resolveConfig,
    envToBool,
    ResolveConfigVariables
} = require("./resolveConfig");
const debug = require("debug");
const {assertion, mkdir, pathExists} = require("./utils");
const {DryMinioBinary} = require("./DryMinioBinary");
const dryMinioBinary = new DryMinioBinary();
const {clearLine} = require("readline");
const {
    DownloadError,
    GenericMMSError,
    Md5CheckFailedError
} = require("./errors");


const log = debug("MinioTST:MinioBinaryDownload")

/**
 * Download and extract the "minio" binary
 */
class MinioBinaryDownload {
    // TODO: for an major version, remove the compat get/set
    // the following get/set are to not break existing stuff

    get checkMD5() {
        return this.binaryOpts.checkMD5
    }

    set checkMD5(val) {
        this.binaryOpts.checkMD5 = val
    }

    get downloadDir() {
        return this.binaryOpts.downloadDir
    }

    set downloadDir(val) {
        this.binaryOpts.downloadDir = val
    }

    get arch() {
        return this.binaryOpts.arch
    }

    set arch(val) {
        this.binaryOpts.arch = val
    }

    get version() {
        return this.binaryOpts.version
    }

    set version(val) {
        this.binaryOpts.version = val
    }

    get platform() {
        return this.binaryOpts.platform
    }

    set platform(val) {
        this.binaryOpts.platform = val
    }

    // end get/set backwards compat section

    constructor(opts) {
        assertion(
            typeof opts.downloadDir === "string",
            new Error("An DownloadDir must be specified!")
        )
        const version =
            opts.version ?? resolveConfig(ResolveConfigVariables.VERSION)
        assertion(
            typeof version === "string",
            new Error("An Minio Binary version must be specified!")
        )

        // dryMinioBinary.generateOptions cannot be used here, because its async
        this.binaryOpts = {
            platform: opts.platform ?? os.platform(),
            arch: opts.arch ?? os.arch(),
            version: version,
            downloadDir: opts.downloadDir,
            checkMD5:
                opts.checkMD5 ??
                envToBool(resolveConfig(ResolveConfigVariables.MD5_CHECK)),
            systemBinary: opts.systemBinary ?? "",
            os: opts.os ?? {os: "unknown"}
        }

        this.dlProgress = {
            current: 0,
            length: 0,
            totalMb: 0,
            lastPrintedAt: 0
        }
    }

    /**
     * Get the full path with filename
     * @returns Absoulte Path with FileName
     */
    async getPath() {
        const opts = await dryMinioBinary.generateOptions(this.binaryOpts)

        return dryMinioBinary.combineBinaryName(
            this.downloadDir,
            await dryMinioBinary.getBinaryName(opts)
        )
    }

    /**
     * Get the path of the already downloaded "minio" file
     * otherwise download it and then return the path
     */
    async getMinioPath() {
        log("getMinioPath")
        const minioPath = await this.getPath()

        if (await pathExists(minioPath)) {
            log(
                `getMinioPath: minio path "${minioPath}" already exists, using this`
            )

            return minioPath
        }

        const minioArchive = await this.startDownload()
        await this.extract(minioArchive)
        await fspromises.unlink(minioArchive)

        if (await pathExists(minioPath)) {
            return minioPath
        }

        throw new Error(
            `Cannot find downloaded minio binary by path "${minioPath}"`
        )
    }

    /**
     * Download the Minio Archive and check it against an MD5
     * @returns The Minio Archive location
     */
    async startDownload() {
        log("startDownload")
        const mbdUrl = new MinioBinaryDownloadUrl(this.binaryOpts)

        await mkdir(this.downloadDir)

        try {
            await fspromises.access(this.downloadDir, constants.X_OK | constants.W_OK) // check that this process has permissions to create files & modify file contents & read file contents
        } catch (err) {
            console.error(
                `Download Directory at "${this.downloadDir}" does not have sufficient permissions to be used by this process\n` +
                "Needed Permissions: Write & Execute (-wx)\n"
            )
            throw err
        }

        const downloadUrl = await mbdUrl.getDownloadUrl()

        const minioArchive = await this.download(downloadUrl)

        await this.makeMD5check(`${downloadUrl}.md5`, minioArchive)

        return minioArchive
    }

    /**
     * Download MD5 file and check it against the Minio Archive
     * @param urlForReferenceMD5 URL to download the MD5
     * @param minioArchive The Minio Archive file location
     *
     * @returns {undefined} if "checkMD5" is falsey
     * @returns {true} if the md5 check was successful
     * @throws if the md5 check failed
     */
    async makeMD5check(urlForReferenceMD5, minioArchive) {
        log("makeMD5check: Checking MD5 of downloaded binary...")

        if (!this.checkMD5) {
            log("makeMD5check: checkMD5 is disabled")

            return undefined
        }

        const archiveMD5Path = await this.download(urlForReferenceMD5)
        const signatureContent = (
            await fspromises.readFile(archiveMD5Path)
        ).toString("utf-8")
        const regexMatch = signatureContent.match(/^\s*([\w\d]+)\s*/i)
        const md5SigRemote = regexMatch ? regexMatch[1] : null
        const md5SigLocal = md5File.sync(minioArchive)
        log(`makeMD5check: Local MD5: ${md5SigLocal}, Remote MD5: ${md5SigRemote}`)

        if (md5SigRemote !== md5SigLocal) {
            throw new Md5CheckFailedError(md5SigLocal, md5SigRemote || "unknown")
        }

        await fspromises.unlink(archiveMD5Path)

        return true
    }

    /**
     * Download file from downloadUrl
     * @param downloadUrl URL to download a File
     * @returns The Path to the downloaded archive file
     */
    async download(downloadUrl) {
        log("download")
        const proxy =
            process.env["yarn_https-proxy"] ||
            process.env.yarn_proxy ||
            process.env["npm_config_https-proxy"] ||
            process.env.npm_config_proxy ||
            process.env.https_proxy ||
            process.env.http_proxy ||
            process.env.HTTPS_PROXY ||
            process.env.HTTP_PROXY

        const strictSsl = process.env.npm_config_strict_ssl === "true"

        const urlObject = new URL(downloadUrl)
        urlObject.port = urlObject.port || "443"

        const requestOptions = {
            method: "GET",
            rejectUnauthorized: strictSsl,
            protocol: envToBool(resolveConfig(ResolveConfigVariables.USE_HTTP))
                ? "http:"
                : "https:",
            agent: proxy ? new HttpsProxyAgent(proxy) : undefined
        }

        const filename = urlObject.pathname.split("/").pop()

        if (!filename) {
            throw new Error(
                `MinioBinaryDownload: missing filename for url "${downloadUrl}"`
            )
        }

        const downloadLocation = path.resolve(this.downloadDir, filename)
        const tempDownloadLocation = path.resolve(
            this.downloadDir,
            `${filename}.downloading`
        )
        log(
            `download: Downloading${
                proxy ? ` via proxy "${proxy}"` : ""
            }: "${downloadUrl}"`
        )

        if (await pathExists(downloadLocation)) {
            log("download: Already downloaded archive found, skipping download")

            return downloadLocation
        }

        this.assignDownloadingURL(urlObject)

        const downloadedFile = await this.httpDownload(
            urlObject,
            requestOptions,
            downloadLocation,
            tempDownloadLocation
        )

        return downloadedFile
    }

    /**
     * Extract given Archive
     * @param minioArchive Archive location
     * @returns extracted directory location
     */
    async extract(minioArchive) {
        log("extract")
        const minioFullPath = await this.getPath()
        log(`extract: archive: "${minioArchive}" final: "${minioFullPath}"`)

        // await mkdir(path.dirname(minioFullPath))
        // move minioArchive to minioFullPath
        await fspromises.copyFile(minioArchive, minioFullPath)

        const filter = file => /(?:bin\/(?:minio(?:\.exe)?))$/i.test(file)

        if (/(.tar.gz|.tgz)$/.test(minioArchive)) {
            await this.extractTarGz(minioArchive, minioFullPath, filter)
        } else if (/.zip$/.test(minioArchive)) {
            await this.extractZip(minioArchive, minioFullPath, filter)
        } /*else {
            throw new Error(
                `MinioBinaryDownload: unsupported archive "${minioArchive}" (downloaded from "${this
                    ._downloadingUrl ??
                "unknown"}"). Broken archive from Minio Provider?`
            )
        }*/

        // if (!(await pathExists(minioFullPath))) {
        //     throw new Error(
        //         `MinioBinaryDownload: missing minio binary in "${minioArchive}" (downloaded from "${this
        //             ._downloadingUrl ??
        //         "unknown"}"). Broken archive from Minio Provider?`
        //     )
        // }

        return minioFullPath
    }

    /**
     * Extract a .tar.gz archive
     * @param minioArchive Archive location
     * @param extractPath Directory to extract to
     * @param filter Method to determine which files to extract
     */
    async extractTarGz(minioArchive, extractPath, filter) {
        log("extractTarGz")
        const extract = tar.extract()
        extract.on("entry", (header, stream, next) => {
            if (filter(header.name)) {
                stream.pipe(
                    createWriteStream(extractPath, {
                        mode: 0o775
                    })
                )
            }

            stream.on("end", () => next())
            stream.resume()
        })

        return new Promise((res, rej) => {
            createReadStream(minioArchive)
                .on("error", err => {
                    rej(
                        new GenericMMSError(
                            "Unable to open tarball " + minioArchive + ": " + err
                        )
                    )
                })
                .pipe(createUnzip())
                .on("error", err => {
                    rej(
                        new GenericMMSError(
                            "Error during unzip for " + minioArchive + ": " + err
                        )
                    )
                })
                .pipe(extract)
                .on("error", err => {
                    rej(
                        new GenericMMSError(
                            "Error during untar for " + minioArchive + ": " + err
                        )
                    )
                })
                .on("finish", res)
        })
    }

    /**
     * Extract a .zip archive
     * @param minioArchive Archive location
     * @param extractPath Directory to extract to
     * @param filter Method to determine which files to extract
     */
    async extractZip(minioArchive, extractPath, filter) {
        log("extractZip")

        return new Promise((resolve, reject) => {
            yauzl.open(minioArchive, {lazyEntries: true}, (err, zipfile) => {
                if (err || !zipfile) {
                    return reject(err)
                }

                zipfile.readEntry()

                zipfile.on("end", () => resolve())

                zipfile.on("entry", entry => {
                    if (!filter(entry.fileName)) {
                        return zipfile.readEntry()
                    }

                    zipfile.openReadStream(entry, (err2, r) => {
                        if (err2 || !r) {
                            return reject(err2)
                        }

                        r.on("end", () => zipfile.readEntry())
                        r.pipe(
                            createWriteStream(extractPath, {
                                mode: 0o775
                            })
                        )
                    })
                })
            })
        })
    }

    /**
     * Downlaod given httpOptions to tempDownloadLocation, then move it to downloadLocation
     * @param httpOptions The httpOptions directly passed to https.get
     * @param downloadLocation The location the File should be after the download
     * @param tempDownloadLocation The location the File should be while downloading
     */
    async httpDownload(url, httpOptions, downloadLocation, tempDownloadLocation) {
        log("httpDownload")
        const downloadUrl = this.assignDownloadingURL(url)

        const maxRedirects = parseInt(
            resolveConfig(ResolveConfigVariables.MAX_REDIRECTS) || ""
        )
        const useHttpsOptions = {
            maxRedirects: Number.isNaN(maxRedirects) ? 2 : maxRedirects,
            ...httpOptions
        }

        return new Promise((resolve, reject) => {
            log(`httpDownload: trying to download "${downloadUrl}"`)
            https
                .get(url, useHttpsOptions, response => {
                    if (response.statusCode != 200) {
                        if (response.statusCode === 403) {
                            reject(
                                new DownloadError(
                                    downloadUrl,
                                    "Status Code is 403 (Minio's 404)\n" +
                                    "This means that the requested version-platform combination doesn't exist\n" +
                                    "Try to use different version 'new MinioTestServer({ binary: { version: 'X.Y.Z' } })'\n" +
                                    "List of available versions can be found here: " +
                                    "https://www.miniob.com/download-center/community/releases/archive"
                                )
                            )

                            return
                        }

                        reject(
                            new DownloadError(
                                downloadUrl,
                                `Status Code isnt 200! (it is ${response.statusCode})`
                            )
                        )

                        return
                    }
                    if (typeof response.headers["content-length"] != "string") {
                        reject(
                            new DownloadError(
                                downloadUrl,
                                'Response header "content-length" is empty!'
                            )
                        )

                        return
                    }

                    this.dlProgress.current = 0
                    this.dlProgress.length = parseInt(
                        response.headers["content-length"],
                        10
                    )
                    this.dlProgress.totalMb =
                        Math.round((this.dlProgress.length / 1048576) * 10) / 10

                    const fileStream = createWriteStream(tempDownloadLocation)

                    response.pipe(fileStream)

                    fileStream.on("finish", async () => {
                        if (
                            this.dlProgress.current < this.dlProgress.length &&
                            !httpOptions.path?.endsWith(".md5")
                        ) {
                            reject(
                                new DownloadError(
                                    downloadUrl,
                                    `Too small (${this.dlProgress.current} bytes) minio binary downloaded.`
                                )
                            )

                            return
                        }

                        this.printDownloadProgress({length: 0}, true)

                        fileStream.close()
                        await fspromises.rename(tempDownloadLocation, downloadLocation)
                        log(
                            `httpDownload: moved "${tempDownloadLocation}" to "${downloadLocation}"`
                        )

                        resolve(downloadLocation)
                    })

                    response.on("data", chunk => {
                        this.printDownloadProgress(chunk)
                    })
                })
                .on("error", err => {
                    // log it without having debug enabled
                    console.error(`Couldnt download "${downloadUrl}"!`, err.message)
                    reject(new DownloadError(downloadUrl, err.message))
                })
        })
    }

    /**
     * Print the Download Progress to STDOUT
     * @param chunk A chunk to get the length
     */
    printDownloadProgress(chunk, forcePrint = false) {
        this.dlProgress.current += chunk.length

        const now = Date.now()

        if (now - this.dlProgress.lastPrintedAt < 2000 && !forcePrint) {
            return
        }

        this.dlProgress.lastPrintedAt = now

        const percentComplete =
            Math.round(
                ((100.0 * this.dlProgress.current) / this.dlProgress.length) * 10
            ) / 10
        const mbComplete = Math.round((this.dlProgress.current / 1048576) * 10) / 10

        const crReturn = this.platform === "win32" ? "\x1b[0G" : "\r"
        const message = `Downloading Minio "${this.version}": ${percentComplete}% (${mbComplete}mb / ${this.dlProgress.totalMb}mb)${crReturn}`

        if (process.stdout.isTTY) {
            // if TTY overwrite last line over and over until finished and clear line to avoid residual characters
            clearLine(process.stdout, 0) // this is because "process.stdout.clearLine" does not exist anymore
            process.stdout.write(message)
        } else {
            console.log(message)
        }
    }

    /**
     * Helper function to de-duplicate assigning "_downloadingUrl"
     */
    assignDownloadingURL(url) {
        this._downloadingUrl = url.href

        return this._downloadingUrl
    }
}

module.exports = {
    MinioBinaryDownload
}

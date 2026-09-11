# Minio for Tests
This package spins up an actual/real Minio server programmatically from within nodejs, for testing or mocking during development. By default it holds the data in specified `dataPath`.  
The server will allow you to connect using aws-sdk or minio client library to the Minio server and run integration tests isolated from each other.

On install, this package downloads the Minio binary and saves it to a cache folder (`~/.cache/minio-binaries`).

## Where the binary comes from

MinIO shut down its community download host: every URL under `https://dl.min.io/server/minio/release/`
answers `410 Gone`, and the replacement `https://dl.min.io/aistor/minio/release/` serves the commercial
AIStor build, which denies every S3 call without a license. Since 1.0.15 the binary is therefore fetched
from the community build attached to the GitHub release:

```
https://github.com/minio/minio/releases/download/<TAG>/minio.<platform>-<arch>.<TAG>
```

The default version is `minio.RELEASE.2025-09-07T16-13-09Z`, the last community release that has
binaries attached to it.

## Configuration (environment variables, prefix `MINIOTST_`)

| Variable | Purpose |
| --- | --- |
| `MINIOTST_VERSION` | Release to use, e.g. `minio.RELEASE.2025-09-07T16-13-09Z` |
| `MINIOTST_GITHUB_RELEASES` | Base of the GitHub-style asset layout (default `https://github.com/minio/minio/releases/download`) — point it at an internal copy of the assets |
| `MINIOTST_DOWNLOAD_MIRROR` | Legacy `dl.min.io` layout: `<mirror>/<platform>-<arch>/archive/<version>` — only for an internal mirror that kept that layout |
| `MINIOTST_DOWNLOAD_URL` | Exact URL of the binary; overrides everything else |
| `MINIOTST_DOWNLOAD_DIR` | Cache directory for the binary |
| `MINIOTST_DEBUG` | Verbose logging |

## Usage

```js
const { MinioServer } = require('minio-for-tests');

const instance = await new MinioServer().create({
  instance: { port: 63208, dataPath: '/tmp/minio-data', launchTimeout: 20000 },
  binary: { version: 'minio.RELEASE.2025-09-07T16-13-09Z' },
  // the console is bound to :9001; disable it if something else uses that port
  spawn: { env: { ...process.env, MINIO_BROWSER: 'off' } }
});
// ... talk to http://127.0.0.1:63208 with minioadmin / minioadmin
await instance.stop();
```

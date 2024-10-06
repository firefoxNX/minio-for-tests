# Minio for Tests
This package spins up an actual/real Minio server programmatically from within nodejs, for testing or mocking during development. By default it holds the data in specified `dataPath`.  
The server will allow you to connect using aws-sdk or minio client library to the Minio server and run integration tests isolated from each other.

On install, this package downloads the latest Minio binaries and saves them to a cache folder.


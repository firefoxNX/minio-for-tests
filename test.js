const {MinioServer} = require('./MinioServer');
const minioServer = new MinioServer();
const {
    S3Client,
    CreateBucketCommand,
    ListBucketsCommand,
    DeleteBucketCommand,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const fs = require('fs');

const run = async () => {
    const currDir = process.cwd();
    let dataPath = `${currDir}/minio_data_tst`;
    // create dataPath if it does not exist
    if (fs.existsSync(dataPath)) {
        fs.rmSync(dataPath, {recursive: true, force: true});
    }
    fs.mkdirSync(dataPath);
    minioServerInstance = await minioServer.create({
        instance: {port: 63208, dataPath: dataPath},
    });
    console.log('Minio server started');
    const s3Client = new S3Client({
        credentials: {
            accessKeyId: 'minioadmin',
            secretAccessKey: 'minioadmin'
        },
        endpoint: 'http://127.0.0.1:63208',
        region: 'us-east-1',
        forcePathStyle: true
    });
    // random bucket name
    const bucketName = 'bucket-' + Math.random().toString(36).substring(7);
    const createBucketCommand = new CreateBucketCommand({Bucket: bucketName});
    await s3Client.send(createBucketCommand);
    console.log('Bucket created');
    // check if the bucket exists
    const listBuckets = await s3Client.send(new ListBucketsCommand({}));
    console.log('Buckets:', listBuckets.Buckets);
    // upload file
    const filePath = `${currDir}/resources/test.txt`;
    const fileStream = fs.createReadStream(filePath);
    const uploadParams = {
        Bucket: bucketName,
        Key: 'test.txt',
        Body: fileStream
    };
    const uploadCommand = new PutObjectCommand(uploadParams);
    await s3Client.send(uploadCommand);
    console.log('File uploaded');
    // download file
    const downloadParams = {
        Bucket: bucketName,
        Key: 'test.txt'
    };
    const downloadCommand = new GetObjectCommand(downloadParams);
    const downloadResponse = await s3Client.send(downloadCommand);
    const downloadFilePath = `${currDir}/resources/test_download.txt`;
    const writeStream = fs.createWriteStream(downloadFilePath);
    downloadResponse.Body.pipe(writeStream);
    writeStream.on('close', () => {
        console.log('File downloaded');
    });
    // delete file
    const deleteCommand = new DeleteObjectCommand({Bucket: bucketName, Key: 'test.txt'});
    await s3Client.send(deleteCommand);
    console.log('File deleted');
    // delete buckets
    for (const bucket of listBuckets.Buckets) {
        await s3Client.send(new DeleteBucketCommand({Bucket: bucket.Name}));
    }
    // stop the minio server
    await minioServerInstance.stop();
}

run();

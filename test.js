const {MinioServer} = require('./MinioServer');
const minioServer = new MinioServer();
const { S3Client, CreateBucketCommand, ListBucketsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const run = async () => {
    const currDir = process.cwd();
    let dataPath = `${currDir}/minio_data_tst`;
    // create dataPath if it does not exist
    if (fs.existsSync(dataPath)) {
        fs.rmSync(dataPath, { recursive: true, force: true });
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
    for (const bucket of listBuckets.Buckets) {
        await s3Client.send(new DeleteBucketCommand({Bucket: bucket.Name}));
    }
    // stop the minio server
    await minioServerInstance.stop();
}

run();

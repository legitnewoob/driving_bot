const { S3Client } = require("@aws-sdk/client-s3");

const directory = process.env.R2_DIRECTORY;

if (!directory) {
    console.error("R2_DIRECTORY is not set in environment variables.");
    process.exit(1);
}

const r2 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT + directory,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});

module.exports = r2;
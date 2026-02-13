const fs = require("fs");
const path = require("path");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const r2 = require("../config/r2Client");
const PROJECT_ROOT = require("./projectRoot");

async function uploadFileToR2(localPath, r2Key) {
    const fileStream = fs.createReadStream(localPath);
    const bucketName = process.env.R2_BUCKET;
    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: r2Key,
        Body: fileStream
    });

    await r2.send(command);
}

async function uploadLogsFolder() {
    
    console.log("Starting logs upload to R2...");
    const baseFolder = path.join(PROJECT_ROOT, "message-logs");

    if (!fs.existsSync(baseFolder)) return;

    const dates = fs.readdirSync(baseFolder);

    for (const date of dates) {
        const datePath = path.join(baseFolder, date);
        const files = fs.readdirSync(datePath);

        for (const file of files) {
            const localFilePath = path.join(datePath, file);
            const r2Key = `${process.env.R2_DIRECTORY}/logs/${date}/${file}`;

            try {
                await uploadFileToR2(localFilePath, r2Key);
            } catch (err) {
                console.error("R2 upload failed:", err);
            }
        }
    }
}

module.exports = uploadLogsFolder;
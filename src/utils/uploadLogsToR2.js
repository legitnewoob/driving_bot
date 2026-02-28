const fs = require("fs");
const path = require("path");
const {
    PutObjectCommand,
    HeadObjectCommand,
    GetObjectCommand
} = require("@aws-sdk/client-s3");

const r2 = require("../config/r2Client");
const PROJECT_ROOT = require("./projectRoot");

const bucketName = process.env.R2_BUCKET;

/**
 * Check if file exists in R2
 */
async function fileExistsInR2(key) {
    try {
        await r2.send(
            new HeadObjectCommand({
                Bucket: bucketName,
                Key: key
            })
        );
        return true;
    } catch (err) {
        if (err.$metadata?.httpStatusCode === 404) {
            return false;
        }
        throw err;
    }
}

/**
 * Download existing file from R2
 */
async function getExistingFileFromR2(key) {
    const response = await r2.send(
        new GetObjectCommand({
            Bucket: bucketName,
            Key: key
        })
    );

    return new Promise((resolve, reject) => {
        let data = "";

        response.Body.on("data", chunk => {
            data += chunk.toString();
        });

        response.Body.on("end", () => {
            resolve(data);
        });

        response.Body.on("error", reject);
    });
}

/**
 * Upload content to R2
 */
async function uploadContentToR2(content, key) {
    await r2.send(
        new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: content
        })
    );
}

/**
 * Upload logs folder
 */
async function uploadLogsFolder() {
    console.log("Starting logs upload to R2...");

    const baseFolder = path.join(PROJECT_ROOT, "message-logs");

    if (!fs.existsSync(baseFolder)) {
        console.log("No logs folder found.");
        return;
    }

    const dates = fs.readdirSync(baseFolder);

    for (const date of dates) {
        const datePath = path.join(baseFolder, date);

        if (!fs.statSync(datePath).isDirectory()) continue;

        const files = fs.readdirSync(datePath);

        for (const file of files) {
            const localFilePath = path.join(datePath, file);

            if (!fs.statSync(localFilePath).isFile()) continue;

            const r2Key = `${process.env.R2_DIRECTORY}/logs/${date}/${file}`;

            try {
                const content = fs.readFileSync(localFilePath, "utf8");

                await uploadContentToR2(content, r2Key);

                console.log(`Uploaded: ${r2Key}`);
            } catch (err) {
                console.error(`R2 upload failed for ${r2Key}:`, err);
            }
        }
    }

    console.log("Logs upload process completed.");
}

module.exports = uploadLogsFolder;
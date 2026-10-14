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

// Last uploaded modification time per file, so unchanged logs aren't re-sent every run
const uploadedAt = new Map();
const NETWORK_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EHOSTUNREACH"]);

function errorCode(err) {
    return err?.code || err?.errors?.[0]?.code || err?.name || "unknown";
}

/**
 * Upload logs folder
 */
async function uploadLogsFolder() {
    if (!bucketName || !process.env.R2_ENDPOINT) return;

    const baseFolder = path.join(PROJECT_ROOT, "message-logs");

    if (!fs.existsSync(baseFolder)) {
        return;
    }

    const dates = fs.readdirSync(baseFolder);

    for (const date of dates) {
        const datePath = path.join(baseFolder, date);

        if (!fs.statSync(datePath).isDirectory()) continue;

        const files = fs.readdirSync(datePath);

        for (const file of files) {
            const localFilePath = path.join(datePath, file);
            const stat = fs.statSync(localFilePath);

            if (!stat.isFile()) continue;
            if (uploadedAt.get(localFilePath) === stat.mtimeMs) continue;

            const r2Key = `${process.env.R2_DIRECTORY}/logs/${date}/${file}`;

            try {
                const content = fs.readFileSync(localFilePath, "utf8");

                await uploadContentToR2(content, r2Key);
                uploadedAt.set(localFilePath, stat.mtimeMs);
            } catch (err) {
                const code = errorCode(err);
                if (NETWORK_ERRORS.has(code)) {
                    // Can't reach R2 at all; the rest would fail too. Try again next run.
                    console.error(`R2 log upload skipped: can't reach R2 (${code}). Will retry next run.`);
                    return;
                }
                console.error(`R2 upload failed for ${r2Key}: ${code} ${err?.message || ""}`.trim());
            }
        }
    }
}

module.exports = uploadLogsFolder;
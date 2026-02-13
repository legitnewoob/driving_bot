const { ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const r2Client = require("../config/r2Client"); // your R2 config

class FetchLogsController {

  async fetchPhones(req, res) {
    try {
      const { date } = req.query;

      if (!date) {
        return res.status(400).json({ message: "Date required" });
      }
      const command = new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
      });

      const data = await r2Client.send(command);

      if (!data.Contents) {
        return res.json([]);
      }

      // Filter matching date + environment
      const filtered = data.Contents.filter(obj =>
        obj.Key.startsWith(`${process.env.R2_DIRECTORY}/logs/${date}/`)
      );

      const phones = filtered.map(obj =>
        obj.Key.split("/").pop().replace(".log", "")
      );

      return res.json(phones);

    } catch (err) {
      console.error("LIST ERROR:", err);
      return res.status(500).json({ message: "Error fetching phones" });
    }
  }

  async fetchLogs(req, res) {
    try {
      const { date, phone } = req.query;

      if (!date || !phone) {
        return res.status(400).json({ message: "Date and phone required" });
      }

      const key = `${process.env.R2_DIRECTORY}/logs/${date}/${phone}.log`;

      const command = new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      });

      const data = await r2Client.send(command);

      res.setHeader("Content-Disposition", `attachment; filename=${phone}.log`);
      data.Body.pipe(res);

    } catch (err) {
      console.error(err);
      return res.status(404).json({ message: "Log not found" });
    }
  }

}

module.exports = new FetchLogsController();
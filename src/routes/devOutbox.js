const express = require("express");
const fs = require("fs");
const path = require("path");
const { OUTBOX_DIR } = require("../utils/emailNotifier");

/**
 * Development only (never mounted in production): the emails kept by
 * EMAIL_OUTBOX=local, newest first, so they can be opened and their links clicked.
 */
const router = express.Router();

const files = () => {
  try {
    return fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith(".html")).sort().reverse();
  } catch {
    return [];
  }
};
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

router.get("/", (req, res) => {
  const rows = files().map((f) => {
    const head = fs.readFileSync(path.join(OUTBOX_DIR, f), "utf8").split("\n", 1)[0];
    let meta = {};
    try {
      meta = JSON.parse(head.replace(/^<!-- /, "").replace(/ -->$/, ""));
    } catch {}
    return `<tr><td>${esc(new Date(meta.at || 0).toLocaleString("en-GB"))}</td><td>${esc(meta.to)}</td><td><a href="/dev/outbox/${encodeURIComponent(f)}">${esc(meta.subject || f)}</a></td></tr>`;
  });
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Outbox</title>
<body style="font-family:-apple-system,Arial,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;">
<h1 style="font-size:20px;">Email outbox <small style="color:#888;font-weight:normal">(EMAIL_OUTBOX=local · ${rows.length} emails)</small></h1>
<form method="post" action="/dev/outbox/clear"><button>Clear</button></form>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px;width:100%;margin-top:12px;"><tr style="text-align:left;background:#f3f4f6"><th>When</th><th>To</th><th>Subject</th></tr>${rows.join("")}</table></body>`);
});

router.post("/clear", (req, res) => {
  for (const f of files()) fs.unlinkSync(path.join(OUTBOX_DIR, f));
  res.redirect("/dev/outbox");
});

router.get("/:file", (req, res) => {
  const name = path.basename(req.params.file);
  const full = path.join(OUTBOX_DIR, name);
  if (!name.endsWith(".html") || !fs.existsSync(full)) return res.status(404).send("Not found");
  res.type("html").send(`<p style="font-family:Arial;"><a href="/dev/outbox">← Outbox</a></p>${fs.readFileSync(full, "utf8")}`);
});

module.exports = router;

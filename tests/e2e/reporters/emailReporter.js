/**
 * Custom Jest reporter that emails an HTML summary after each e2e run.
 *
 * Opt-in: only emails when EMAIL_REPORT=1 (so local debug runs don't spam).
 *
 * Required env vars (already used by src/utils/emailNotifier.js):
 *   NOTIFY_EMAIL_USER  - Gmail address to send from
 *   NOTIFY_EMAIL_PASS  - Gmail App Password
 *   NOTIFY_EMAIL_TO    - Recipient (defaults to NOTIFY_EMAIL_USER)
 *
 * Usage:
 *   $env:EMAIL_REPORT="1"; npm run test:e2e
 *   # or
 *   npm run test:e2e:report
 */

const path = require("path");
const fs = require("fs");

const PROJECT_ROOT = path.join(__dirname, "..", "..", "..");

// ── Load env vars ────────────────────────────────────────────────────────
// Jest reporters run in the MAIN Jest process — NOT the test sandbox where
// tests/e2e/setup.js runs. So we need to load envs/.env.test here too,
// otherwise NOTIFY_EMAIL_USER / NOTIFY_EMAIL_PASS won't be available.
if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
if (!process.env.LOAD_ENV) process.env.LOAD_ENV = "test";
try {
  require(path.join(PROJECT_ROOT, "src", "config", "env"));
} catch (_) {
  // env config is optional — reporter still works for the local HTML file
}

class EmailReporter {
  constructor(globalConfig, reporterOptions = {}) {
    this._globalConfig = globalConfig;
    this._options = reporterOptions;
    this._startTime = Date.now();
  }

  /**
   * Called by Jest after all tests have finished.
   */
  async onRunComplete(_testContexts, results) {
    const html = buildHtmlReport(results, this._startTime);

    // Always write the report to disk so it's easy to open locally
    const reportDir = path.join(PROJECT_ROOT, "tests", "e2e", "reports");
    fs.mkdirSync(reportDir, { recursive: true });
    const filename = `e2e-report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
    const reportPath = path.join(reportDir, filename);
    fs.writeFileSync(reportPath, html, "utf8");

    // eslint-disable-next-line no-console
    console.log(`\n📊 E2E report saved to: ${reportPath}`);

    // Only email when explicitly requested (avoids spamming during dev)
    if (process.env.EMAIL_REPORT !== "1") {
      console.log("   (set EMAIL_REPORT=1 to also email this report)\n");
      return;
    }

    try {
      // Lazy-require so the reporter still works when nodemailer isn't installed
      const { sendNotification } = require("../../../src/utils/emailNotifier");

      const passed = (results.numFailedTests || 0) === 0
        && (results.numFailedTestSuites || 0) === 0;
      const status = passed ? "✅ PASS" : "❌ FAIL";
      const subject =
        `${status} E2E Report — ${results.numPassedTests}/${results.numTotalTests} passed` +
        (results.numFailedTests ? ` (${results.numFailedTests} failed)` : "");

      const sent = await sendNotification(subject, html);
      if (sent) {
        console.log(`📧 E2E report emailed successfully\n`);
      } else {
        console.log(
          `⚠️  E2E report email NOT sent. Check NOTIFY_EMAIL_USER / NOTIFY_EMAIL_PASS in envs/.env.test\n`
        );
      }
    } catch (err) {
      console.error(`⚠️  E2E report email failed: ${err.message}\n`);
    }
  }
}

// ─── HTML report builder ────────────────────────────────────────────────

function buildHtmlReport(results, startTime) {
  const durationMs = Date.now() - startTime;
  const durationStr = formatDuration(durationMs);

  const totals = {
    suites: results.numTotalTestSuites,
    suitesPassed: results.numPassedTestSuites,
    suitesFailed: results.numFailedTestSuites,
    tests: results.numTotalTests,
    passed: results.numPassedTests,
    failed: results.numFailedTests,
    skipped: results.numPendingTests + results.numTodoTests,
  };

  // results.success can be flaky (false positives from open handles, etc).
  // Trust the actual counts instead.
  const passed = (results.numFailedTests || 0) === 0
    && (results.numFailedTestSuites || 0) === 0;
  const overallStatus = passed ? "PASS" : "FAIL";
  const statusColor = passed ? "#10b981" : "#ef4444";

  // Build per-suite sections
  const suitesHtml = (results.testResults || [])
    .map((suite) => renderSuite(suite))
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E2E Test Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 960px; margin: 0 auto; padding: 24px; background: #f8fafc; color: #1e293b; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  .subtitle { color: #64748b; margin-bottom: 24px; }
  .banner { background: ${statusColor}; color: white; padding: 16px 24px; border-radius: 8px;
    font-size: 20px; font-weight: 600; margin-bottom: 24px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: white; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0;
    box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
  .stat.pass .num { color: #10b981; }
  .stat.fail .num { color: #ef4444; }
  .stat.skip .num { color: #f59e0b; }
  .suite { background: white; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 16px;
    overflow: hidden; }
  .suite-header { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid #f1f5f9; }
  .suite-header.pass { background: #f0fdf4; }
  .suite-header.fail { background: #fef2f2; }
  .suite-name { font-weight: 600; font-size: 14px; }
  .suite-meta { font-size: 12px; color: #64748b; }
  .test { padding: 8px 16px; font-size: 13px; border-bottom: 1px solid #f8fafc; display: flex;
    justify-content: space-between; align-items: center; }
  .test:last-child { border-bottom: none; }
  .test .name { flex: 1; }
  .test .duration { color: #94a3b8; font-size: 11px; margin-left: 12px; }
  .test.pass .name::before { content: "✓ "; color: #10b981; font-weight: 700; }
  .test.fail .name::before { content: "✗ "; color: #ef4444; font-weight: 700; }
  .test.skip .name::before { content: "○ "; color: #f59e0b; font-weight: 700; }
  .test.skip .name { color: #94a3b8; }
  .err { background: #fef2f2; border-left: 3px solid #ef4444; padding: 12px 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    white-space: pre-wrap; color: #7f1d1d; margin: 4px 16px 12px; border-radius: 4px;
    overflow-x: auto; }
  .footer { color: #94a3b8; font-size: 12px; margin-top: 32px; text-align: center; }
</style>
</head>
<body>
<h1>E2E Test Report</h1>
<div class="subtitle">${new Date().toLocaleString()} · ${durationStr}</div>

<div class="banner">${overallStatus === "PASS" ? "✅" : "❌"} ${overallStatus}
  — ${totals.passed}/${totals.tests} tests passed</div>

<div class="stats">
  <div class="stat"><div class="num">${totals.suites}</div><div class="label">Suites</div></div>
  <div class="stat pass"><div class="num">${totals.passed}</div><div class="label">Passed</div></div>
  <div class="stat fail"><div class="num">${totals.failed}</div><div class="label">Failed</div></div>
  <div class="stat skip"><div class="num">${totals.skipped}</div><div class="label">Skipped</div></div>
</div>

${suitesHtml || '<div class="suite"><div class="suite-header"><span>No tests ran</span></div></div>'}

<div class="footer">Generated by tests/e2e/reporters/emailReporter.js</div>
</body>
</html>`;
}

function renderSuite(suite) {
  const filePath = suite.testFilePath || "(unknown)";
  const relPath = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, "/");
  const passed = suite.numPassingTests;
  const failed = suite.numFailingTests;
  const skipped = suite.numPendingTests + (suite.numTodoTests || 0);
  const status = failed > 0 ? "fail" : "pass";
  const duration = suite.perfStats
    ? formatDuration(suite.perfStats.runtime || 0)
    : "";

  // Suite-level error (e.g. failed beforeAll)
  const suiteErrorHtml = suite.failureMessage
    ? `<div class="err">${escapeHtml(stripAnsi(suite.failureMessage))}</div>`
    : "";

  const testsHtml = (suite.testResults || [])
    .map((t) => renderTest(t))
    .join("\n");

  return `<div class="suite">
  <div class="suite-header ${status}">
    <span class="suite-name">${escapeHtml(relPath)}</span>
    <span class="suite-meta">${passed} passed${failed ? ", " + failed + " failed" : ""}${skipped ? ", " + skipped + " skipped" : ""} · ${duration}</span>
  </div>
  ${suiteErrorHtml}
  ${testsHtml}
</div>`;
}

function renderTest(t) {
  let cls = "skip";
  if (t.status === "passed") cls = "pass";
  else if (t.status === "failed") cls = "fail";

  const fullName = (t.ancestorTitles || []).concat(t.title).join(" › ");
  const duration = t.duration ? formatDuration(t.duration) : "";

  let errHtml = "";
  if (t.status === "failed" && t.failureMessages && t.failureMessages.length) {
    errHtml = `<div class="err">${escapeHtml(stripAnsi(t.failureMessages.join("\n\n")))}</div>`;
  }

  return `<div class="test ${cls}">
    <span class="name">${escapeHtml(fullName)}</span>
    <span class="duration">${duration}</span>
  </div>${errHtml}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

module.exports = EmailReporter;

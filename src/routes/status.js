const express = require("express");
const router = express.Router();
const os = require("os");
const { basicAuth } = require("../middleware/auth");
const timezoneUtils = require("../utils/timezoneUtils");

/**
 * Build health metrics
 */
function getHealthData() {
  const now = timezoneUtils.getCurrentDate();

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const memoryUsagePercent = Math.round((usedMem / totalMem) * 100);

  return {
    status: "UP",
    timestamp: timezoneUtils.formatDate(now, "YYYY-MM-DD HH:mm:ss z"),
    uptime: `${Math.floor(process.uptime())} seconds`,

    system: {
      platform: process.platform,
      nodeVersion: process.version,

      memory: {
        total: `${Math.round(totalMem / 1024 / 1024)} MB`,
        free: `${Math.round(freeMem / 1024 / 1024)} MB`,
        usage: `${memoryUsagePercent}%`,
      },

      cpu: {
        cores: os.cpus().length,
        load: os.loadavg(),
      },
    },

    process: {
      pid: process.pid,
      memoryUsage: {
        rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
      },
    },
  };
}

/**
 * HTML Dashboard Renderer
 */
function renderDashboard(healthData) {
  const memoryUsagePercent = parseInt(healthData.system.memory.usage);
  const memoryBarColor =
    memoryUsagePercent < 70
      ? "green"
      : memoryUsagePercent < 90
      ? "orange"
      : "red";

  return `
<!DOCTYPE html>
<html>
<head>
<title>Driving Bot Health</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<style>
body{
  font-family:Arial;
  background:#f4f6f9;
  padding:20px;
}

.container{
  max-width:800px;
  margin:auto;
}

.card{
  background:white;
  padding:20px;
  border-radius:10px;
  margin-bottom:20px;
  box-shadow:0 2px 5px rgba(0,0,0,0.1);
}

.status{
  padding:6px 12px;
  border-radius:6px;
  color:white;
  background:${healthData.status === "UP" ? "green" : "red"};
}

.progress{
  width:100%;
  height:15px;
  background:#ddd;
  border-radius:8px;
  overflow:hidden;
}

.progress-fill{
  height:100%;
  width:${healthData.system.memory.usage};
  background:${memoryBarColor};
}
</style>

<script>
async function refresh(){
  const res = await fetch(window.location.href,{
    headers:{'Accept':'application/json'}
  })

  const data = await res.json()

  document.getElementById("uptime").innerText = data.uptime
  document.getElementById("timestamp").innerText = data.timestamp
  document.getElementById("memoryUsage").innerText = data.system.memory.usage

  document.querySelector(".progress-fill").style.width = data.system.memory.usage

  setTimeout(refresh,1000)
}

window.onload = refresh
</script>

</head>

<body>

<div class="container">

<h1>Driving Bot Health</h1>

<div class="card">
<h3>Status</h3>
<span class="status">${healthData.status}</span>
<p>Uptime: <span id="uptime">${healthData.uptime}</span></p>
<p>Time: <span id="timestamp">${healthData.timestamp}</span></p>
</div>

<div class="card">
<h3>System</h3>
<p>Platform: ${healthData.system.platform}</p>
<p>Node: ${healthData.system.nodeVersion}</p>
<p>CPU Cores: ${healthData.system.cpu.cores}</p>
<p>Load: ${healthData.system.cpu.load.join(", ")}</p>
</div>

<div class="card">
<h3>Memory</h3>

<div class="progress">
<div class="progress-fill"></div>
</div>

<p>
Usage: <span id="memoryUsage">${healthData.system.memory.usage}</span>
</p>

<p>Total: ${healthData.system.memory.total}</p>
<p>Free: ${healthData.system.memory.free}</p>

</div>

<div class="card">
<h3>Process</h3>

<p>PID: ${healthData.process.pid}</p>
<p>RSS: ${healthData.process.memoryUsage.rss}</p>
<p>Heap Total: ${healthData.process.memoryUsage.heapTotal}</p>
<p>Heap Used: ${healthData.process.memoryUsage.heapUsed}</p>

</div>

</div>

</body>
</html>
`;
}

/**
 * Health Endpoint
 */
router.get("/health", basicAuth, (req, res) => {
  const healthData = getHealthData();

  const acceptHeader = req.get("Accept");

  if (acceptHeader && acceptHeader.includes("application/json")) {
    return res.status(200).json(healthData);
  }

  res.setHeader("Content-Type", "text/html");
  res.send(renderDashboard(healthData));
});

module.exports = router;
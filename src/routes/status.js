const express = require('express');
const router = express.Router();
const os = require('os');
const { basicAuth } = require('../middleware/auth');
const timezoneUtils = require('../utils/timezoneUtils'); // 👈 add this

// Basic system information
const startTime = timezoneUtils.getCurrentDate();

/**
 * Health endpoint to monitor application status and performance
 */
router.get('/health', basicAuth, (req, res) => {
  const uptime = Math.floor((timezoneUtils.getCurrentDate() - startTime) / 1000); // in seconds

  const healthData = {
    status: 'UP',
    timestamp: timezoneUtils.formatDate(timezoneUtils.getCurrentDate(), 'YYYY-MM-DD HH:mm:ss z'),
    uptime: `${uptime} seconds`,
    system: {
      platform: process.platform,
      nodeVersion: process.version,
      memory: {
        total: `${Math.round(os.totalmem() / (1024 * 1024))} MB`,
        free: `${Math.round(os.freemem() / (1024 * 1024))} MB`,
        usage: `${Math.round((os.totalmem() - os.freemem()) / os.totalmem() * 100)}%`
      },
      cpu: {
        cores: os.cpus().length,
        load: os.loadavg()
      }
    },
    process: {
      pid: process.pid,
      memoryUsage: {
        rss: `${Math.round(process.memoryUsage().rss / (1024 * 1024))} MB`,
        heapTotal: `${Math.round(process.memoryUsage().heapTotal / (1024 * 1024))} MB`,
        heapUsed: `${Math.round(process.memoryUsage().heapUsed / (1024 * 1024))} MB`,
      }
    }
  };

  // JSON response
  const acceptHeader = req.get('Accept');
  if (acceptHeader && acceptHeader.includes('application/json')) {
    return res.json(healthData);
  }

  const statusColor = healthData.status === 'UP' ? 'green' : 'red';
  const memoryUsagePercent = parseInt(healthData.system.memory.usage);
  const memoryBarColor = memoryUsagePercent < 70 ? 'green' : memoryUsagePercent < 90 ? 'orange' : 'red';
  const refreshInterval = 1000; // 1 second

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Driving Bot - System Health</title>
  <script>
    function setupAutoRefresh() {
      const refreshInterval = ${refreshInterval};
      
      async function refreshData() {
        try {
          const response = await fetch(window.location.href, {
            headers: { 'Accept': 'application/json' }
          });
          const data = await response.json();
          
          document.querySelector('.status-badge').textContent = data.status;
          document.querySelector('.status-badge').style.backgroundColor = data.status === 'UP' ? 'green' : 'red';
          
          document.getElementById('uptime').textContent = data.uptime;
          document.getElementById('timestamp').textContent = data.timestamp;
          document.getElementById('platform').textContent = data.system.platform;
          document.getElementById('nodeVersion').textContent = data.system.nodeVersion;
          document.getElementById('cpuCores').textContent = data.system.cpu.cores;
          document.getElementById('cpuLoad').textContent = data.system.cpu.load.join(', ');
          
          const memoryUsagePercent = parseInt(data.system.memory.usage);
          const memoryBarColor = memoryUsagePercent < 70 ? 'green' : memoryUsagePercent < 90 ? 'orange' : 'red';
          document.querySelector('.progress-fill').style.backgroundColor = memoryBarColor;
          document.querySelector('.progress-fill').style.width = data.system.memory.usage;
          document.getElementById('memoryUsage').textContent = data.system.memory.usage;
          document.getElementById('totalMemory').textContent = data.system.memory.total;
          document.getElementById('freeMemory').textContent = data.system.memory.free;
          
          document.getElementById('pid').textContent = data.process.pid;
          document.getElementById('rss').textContent = data.process.memoryUsage.rss;
          document.getElementById('heapTotal').textContent = data.process.memoryUsage.heapTotal;
          document.getElementById('heapUsed').textContent = data.process.memoryUsage.heapUsed;
          
          document.getElementById('lastRefresh').textContent = new Date().toLocaleTimeString();
        } catch (error) {
          console.error('Error refreshing data:', error);
        }
        
        setTimeout(refreshData, refreshInterval);
      }
      
      setTimeout(refreshData, refreshInterval);
      setInterval(() => {
        document.getElementById('lastRefresh').textContent = new Date().toLocaleTimeString();
      }, 1000);
    }
    window.onload = setupAutoRefresh;
  </script>
  <style>
    /* (keep your existing styles) */
  </style>
</head>
<body>
  <div class="container">
    <h1>System Health Dashboard</h1>
    
    <div class="card">
      <h2>System Status</h2>
      <p><span class="status-badge">${healthData.status}</span></p>
      <p><strong>Uptime:</strong> <span id="uptime">${healthData.uptime}</span></p>
      <p><strong>Current Time:</strong> <span id="timestamp">${healthData.timestamp}</span></p>
    </div>
    
    <!-- (rest of your HTML unchanged) -->
    
    <div class="auto-refresh">
      <div>
        <span class="refresh-indicator"></span>
        Auto-refreshing every ${refreshInterval / 1000} second${refreshInterval / 1000 > 1 ? 's' : ''}
      </div>
      <div>Last updated: <span id="lastRefresh">${timezoneUtils.formatDate(timezoneUtils.getCurrentDate(), 'HH:mm:ss')}</span></div>
    </div>
    
    <div class="footer">
      <p>Driving Bot Health Monitor • ${timezoneUtils.getCurrentDate().getFullYear()}</p>
    </div>
  </div>
</body>
</html>
  `;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

module.exports = router;
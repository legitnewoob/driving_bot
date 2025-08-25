const express = require('express');
const router = express.Router();
const os = require('os');

// Basic system information
const startTime = Date.now();

/**
 * Health endpoint to monitor application status and performance
 */
router.get('/health', (req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000); // in seconds

  const healthData = {
    status: 'UP',
    timestamp: new Date().toISOString(),
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

  // Check if the client wants JSON (for API clients)
  const acceptHeader = req.get('Accept');
  if (acceptHeader && acceptHeader.includes('application/json')) {
    return res.json(healthData);
  }

  // Otherwise render HTML
  const statusColor = healthData.status === 'UP' ? 'green' : 'red';
  const memoryUsagePercent = parseInt(healthData.system.memory.usage);
  const memoryBarColor = memoryUsagePercent < 70 ? 'green' : memoryUsagePercent < 90 ? 'orange' : 'red';
  const refreshInterval = 1000; // 10 seconds

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Driving Bot - System Health</title>
  <!-- Add this script for auto-refresh without full page reload -->
  <script>
    // Refresh the data every 5 seconds (5000ms)
    function setupAutoRefresh() {
      const refreshInterval = ${refreshInterval};
      
      async function refreshData() {
        try {
          const response = await fetch(window.location.href, {
            headers: { 'Accept': 'application/json' }
          });
          const data = await response.json();
          
          // Update status
          document.querySelector('.status-badge').textContent = data.status;
          document.querySelector('.status-badge').style.backgroundColor = data.status === 'UP' ? 'green' : 'red';
          
          // Update uptime and timestamp
          document.getElementById('uptime').textContent = data.uptime;
          document.getElementById('timestamp').textContent = data.timestamp;
          
          // Update system info
          document.getElementById('platform').textContent = data.system.platform;
          document.getElementById('nodeVersion').textContent = data.system.nodeVersion;
          document.getElementById('cpuCores').textContent = data.system.cpu.cores;
          document.getElementById('cpuLoad').textContent = data.system.cpu.load.join(', ');
          
          // Update memory info
          const memoryUsagePercent = parseInt(data.system.memory.usage);
          const memoryBarColor = memoryUsagePercent < 70 ? 'green' : memoryUsagePercent < 90 ? 'orange' : 'red';
          document.querySelector('.progress-fill').style.backgroundColor = memoryBarColor;
          document.querySelector('.progress-fill').style.width = data.system.memory.usage;
          document.getElementById('memoryUsage').textContent = data.system.memory.usage;
          document.getElementById('totalMemory').textContent = data.system.memory.total;
          document.getElementById('freeMemory').textContent = data.system.memory.free;
          
          // Update process info
          document.getElementById('pid').textContent = data.process.pid;
          document.getElementById('rss').textContent = data.process.memoryUsage.rss;
          document.getElementById('heapTotal').textContent = data.process.memoryUsage.heapTotal;
          document.getElementById('heapUsed').textContent = data.process.memoryUsage.heapUsed;
          
          // Update last refresh time
          document.getElementById('lastRefresh').textContent = new Date().toLocaleTimeString();
        } catch (error) {
          console.error('Error refreshing data:', error);
        }
        
        setTimeout(refreshData, refreshInterval);
      }
      
      // Initial delay before starting auto-refresh
      setTimeout(refreshData, refreshInterval);
      
      // Show when the last refresh happened
      setInterval(() => {
        document.getElementById('lastRefresh').textContent = new Date().toLocaleTimeString();
      }, 1000);
    }
    
    // Initialize when page loads
    window.onload = setupAutoRefresh;
  </script>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f7f9;
    }
    .container {
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    h1 {
      color: #2c3e50;
      border-bottom: 1px solid #eee;
      padding-bottom: 10px;
      margin-top: 0;
    }
    .status-badge {
      display: inline-block;
      padding: 5px 15px;
      border-radius: 20px;
      font-weight: bold;
      background-color: ${statusColor};
      color: white;
    }
    .card {
      background: #f8f9fa;
      border-radius: 6px;
      padding: 15px;
      margin-bottom: 20px;
      border-left: 4px solid #4a6fa5;
    }
    .card h2 {
      margin-top: 0;
      font-size: 18px;
      color: #4a6fa5;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 8px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    th {
      background-color: #f2f2f2;
      font-weight: 500;
    }
    .progress-bar {
      height: 10px;
      background: #e0e0e0;
      border-radius: 5px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background-color: ${memoryBarColor};
      width: ${healthData.system.memory.usage};
    }
    .footer {
      text-align: center;
      margin-top: 40px;
      color: #7f8c8d;
      font-size: 12px;
    }
    .refresh-btn {
      background-color: #4a6fa5;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      margin-top: 20px;
    }
    .refresh-btn:hover {
      background-color: #3a5985;
    }
    .auto-refresh {
      background: #f8f9fa;
      padding: 10px;
      border-radius: 4px;
      margin-top: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .refresh-indicator {
      display: inline-block;
      width: 10px;
      height: 10px;
      background-color: #4a6fa5;
      border-radius: 50%;
      margin-right: 8px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.3; }
      100% { opacity: 1; }
    }
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
    
    <div class="card">
      <h2>System Information</h2>
      <table>
        <tr>
          <th>Platform</th>
          <td id="platform">${healthData.system.platform}</td>
        </tr>
        <tr>
          <th>Node.js Version</th>
          <td id="nodeVersion">${healthData.system.nodeVersion}</td>
        </tr>
        <tr>
          <th>CPU Cores</th>
          <td id="cpuCores">${healthData.system.cpu.cores}</td>
        </tr>
        <tr>
          <th>CPU Load Average</th>
          <td id="cpuLoad">${healthData.system.cpu.load.join(', ')}</td>
        </tr>
      </table>
    </div>
    
    <div class="card">
      <h2>Memory Usage</h2>
      <div class="progress-bar">
        <div class="progress-fill"></div>
      </div>
      <p><span id="memoryUsage">${healthData.system.memory.usage}</span> used</p>
      <table>
        <tr>
          <th>Total Memory</th>
          <td id="totalMemory">${healthData.system.memory.total}</td>
        </tr>
        <tr>
          <th>Free Memory</th>
          <td id="freeMemory">${healthData.system.memory.free}</td>
        </tr>
      </table>
    </div>
    
    <div class="card">
      <h2>Process Information</h2>
      <table>
        <tr>
          <th>Process ID</th>
          <td id="pid">${healthData.process.pid}</td>
        </tr>
        <tr>
          <th>RSS Memory</th>
          <td id="rss">${healthData.process.memoryUsage.rss}</td>
        </tr>
        <tr>
          <th>Heap Total</th>
          <td id="heapTotal">${healthData.process.memoryUsage.heapTotal}</td>
        </tr>
        <tr>
          <th>Heap Used</th>
          <td id="heapUsed">${healthData.process.memoryUsage.heapUsed}</td>
        </tr>
      </table>
    </div>
    
    <div class="auto-refresh">
      <div>
        <span class="refresh-indicator"></span>
        Auto-refreshing every ${refreshInterval / 1000} seconds
      </div>
      <div>Last updated: <span id="lastRefresh">${new Date().toLocaleTimeString()}</span></div>
    </div>
    
    <button class="refresh-btn" onclick="location.reload()">Manual Refresh</button>
    
    <div class="footer">
      <p>Driving Bot Health Monitor • ${new Date().getFullYear()}</p>
    </div>
  </div>
</body>
</html>
  `;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

module.exports = router;
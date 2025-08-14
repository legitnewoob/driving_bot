const express = require('express');
const { PORT } = require('./config');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();
app.use(express.json());

app.use('/', webhookRoutes);

app.get('/', (req, res) => {
  res.json({ success: true, response: "I AM ALIVEEEE" });
});

app.listen(PORT, () => {
  
    console.log(`✅ WhatsApp Bot server running on port ${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});

module.exports = app;
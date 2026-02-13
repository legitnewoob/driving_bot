const express = require('express');
const fetchLogsController = require('../controllers/fetchLogsController');

const router = express.Router();


router.get('/phones', fetchLogsController.fetchPhones.bind(fetchLogsController));
router.get('/getLog', fetchLogsController.fetchLogs.bind(fetchLogsController));

module.exports = router;
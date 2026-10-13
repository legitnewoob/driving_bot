const mongoose = require("mongoose");

// Persistence helpers skip work when there's no live connection (unit tests,
// startup races) instead of letting Mongoose buffer the call for 10 seconds.
function isDbReady() {
  return mongoose.connection.readyState === 1;
}

module.exports = { isDbReady };

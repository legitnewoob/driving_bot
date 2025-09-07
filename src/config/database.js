const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    // 1. Define a base options object.
    // Note: useNewUrlParser and useUnifiedTopology are deprecated in Mongoose 6+
    // and are no longer needed.
    const connectionOptions = {};

    // 2. Conditionally add dbName to options if the DB_NAME env var is set.
    if (process.env.DB_NAME) {
      connectionOptions.dbName = process.env.DB_NAME;
      console.log(`🔌 Attempting to connect to database: ${process.env.DB_NAME}`);
    }

    // 3. Connect using the URI and the constructed options.
    await mongoose.connect(process.env.REMOVED_REMOVED_MONGO_URI, connectionOptions);

    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
const fs = require("fs");
const path = require("path");

function findProjectRoot(startDir) {
  let currentDir = startDir;
    console.log("Starting search for project root from:", currentDir);
  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error("❌ Could not find project root (package.json not found)");
    }

    currentDir = parentDir;
  }
}

module.exports = findProjectRoot(__dirname);
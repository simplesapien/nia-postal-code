const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CSV = path.join(__dirname, "..", "data", "nia-coverage-master.csv");
const POLL_SEC = parseInt(process.env.POLL_SEC, 10) || 30;
const RCLONE_FLAGS = "--drive-export-formats csv";

function hash(file) {
  if (!fs.existsSync(file)) return "";
  return crypto
    .createHash("md5")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function pull() {
  execSync(
    `rclone copy gdrive:nia-coverage-master.csv data/ ${RCLONE_FLAGS}`,
    { cwd: path.join(__dirname, ".."), stdio: "pipe" }
  );
}

function rebuild() {
  execSync("node scripts/rebuild-data.js", {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
  });
}

let lastHash = hash(CSV);

console.log(`Watching Google Sheet every ${POLL_SEC}s (Ctrl-C to stop)`);
console.log(`Current hash: ${lastHash.slice(0, 8)}…\n`);

async function tick() {
  try {
    pull();
    const newHash = hash(CSV);
    if (newHash !== lastHash) {
      console.log(
        `[${new Date().toLocaleTimeString()}] Sheet changed — rebuilding…`
      );
      rebuild();
      lastHash = newHash;
      console.log("");
    }
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Poll error:`, err.message);
  }
}

tick();
setInterval(tick, POLL_SEC * 1000);

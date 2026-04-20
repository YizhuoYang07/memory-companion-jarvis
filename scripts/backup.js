import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readConfig } from "../src/config.js";

const config = readConfig();
const sourcePath = path.resolve(config.databasePath);
const backupDirectory = path.resolve(process.argv[2] || "backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDirectory, `memory-${timestamp}.sqlite`);

if (!fs.existsSync(sourcePath)) {
  console.error(`Database not found: ${sourcePath}`);
  process.exit(1);
}

fs.mkdirSync(backupDirectory, { recursive: true });

const database = new DatabaseSync(sourcePath);

try {
  database.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  console.log(`Backup written to ${backupPath}`);
} finally {
  database.close();
}

function quoteSqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
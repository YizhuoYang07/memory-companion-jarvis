import fs from "node:fs";
import path from "node:path";
import { readConfig } from "../src/config.js";

const sourceBackupPath = process.argv[2];

if (!sourceBackupPath) {
  console.error("Usage: node scripts/restore.js <backup-file>");
  process.exit(1);
}

const config = readConfig();
const databasePath = path.resolve(config.databasePath);
const backupPath = path.resolve(sourceBackupPath);

if (!fs.existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

for (const suffix of ["", "-shm", "-wal"]) {
  const target = `${databasePath}${suffix}`;
  if (fs.existsSync(target)) {
    fs.rmSync(target, { force: true });
  }
}

fs.copyFileSync(backupPath, databasePath);
console.log(`Database restored from ${backupPath} to ${databasePath}`);
console.log("Make sure the server process is stopped before running restore.");
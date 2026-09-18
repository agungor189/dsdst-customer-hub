import { loadConfig } from "../config.js";
import { openDatabase } from "./index.js";
const db = openDatabase(loadConfig().databasePath);
console.log("Migrations applied", db.prepare("SELECT * FROM schema_migrations ORDER BY version").all());
db.close();

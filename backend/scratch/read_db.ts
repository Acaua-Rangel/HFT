import { Database } from "bun:sqlite";

const db = new Database("hft.sqlite");
const schema = db.query("PRAGMA table_info(transaction_logs)").all();
console.log("Schema:", schema);
const count = db.query("SELECT COUNT(*) as c FROM transaction_logs").get();
console.log("Count:", count);

import { writeFileSync } from "node:fs";

// An app-server that accepts input and never answers: a hung Codex.
if (process.env.HUNG_PID_FILE) writeFileSync(process.env.HUNG_PID_FILE, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);

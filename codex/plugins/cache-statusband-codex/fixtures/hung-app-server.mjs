import { writeFileSync } from "node:fs";

// An app-server that accepts input and never answers: a hung Codex.
// The pid is recorded synchronously, as the very first statement, so a test can tell a server
// that started from one that was killed or never launched.
if (process.env.HUNG_PID_FILE) writeFileSync(process.env.HUNG_PID_FILE, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);

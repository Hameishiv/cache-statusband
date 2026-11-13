// Preloaded into the CLI (NODE_OPTIONS=--import) by a test that needs the account read to fail
// with a specific system error. FAKE_ACCOUNT_ERROR_CODE is the error code; FAKE_ACCOUNT_ERROR_ON
// is "stdin" (a failed write to the child, like a real EPIPE) or "child" (a spawn-time error).
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const real = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = real(...args);
  const code = process.env.FAKE_ACCOUNT_ERROR_CODE;
  // Only the account read's child has a stdin pipe; the helper spawns (taskkill) do not.
  if (code && child.stdin) {
    const error = Object.assign(new Error(`injected ${code}`), { code });
    setImmediate(() => (process.env.FAKE_ACCOUNT_ERROR_ON === "stdin" ? child.stdin : child).emit("error", error));
  }
  return child;
};
syncBuiltinESMExports();

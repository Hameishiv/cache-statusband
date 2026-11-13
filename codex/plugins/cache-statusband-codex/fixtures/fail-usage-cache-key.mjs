// Preloaded into the CLI (NODE_OPTIONS=--import) by a test that needs the usage read to throw:
// the cache file name is derived with createHash, which usage.mjs does not guard, so making it
// throw only when the cache name is built (a sha256 over an "account:" identity key) makes the
// whole usage step fail while session scanning still works.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const real = crypto.createHash;
crypto.createHash = (algorithm, ...rest) => {
  const hash = real(algorithm, ...rest);
  const update = hash.update.bind(hash);
  hash.update = (data, ...more) => {
    if (typeof data === "string" && data.startsWith("account:")) throw new Error("simulated failure while building the cache name");
    return update(data, ...more);
  };
  return hash;
};
syncBuiltinESMExports();

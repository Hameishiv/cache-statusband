import { createInterface } from "node:readline";

if (process.env.EXPECT_CODEX_HOME && process.env.CODEX_HOME !== process.env.EXPECT_CODEX_HOME) {
  process.stderr.write("CODEX_HOME was not forwarded\n");
  process.exit(7);
}

const lines = createInterface({ input: process.stdin });
const testEmail = ["test", "example.invalid"].join("@");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "test" } })}\n`);
  if (message.id === 2) {
    process.stdout.write(`${JSON.stringify({ id: 2, result: { account: { type: "chatgpt", email: testEmail, planType: "pro" } } })}\n`);
  }
  if (message.id === 3) {
    process.stdout.write(`${JSON.stringify({
      id: 3,
      result: {
        rateLimits: {
          primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: 1_793_285_913 },
          secondary: { usedPercent: 14, windowDurationMins: 10_080, resetsAt: 1_793_796_876 },
        },
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [{ id: "opaque-reset-id", title: "Full reset", expiresAt: 1_793_302_971 }],
        },
        accountId: "opaque-account-id",
      },
    })}\n`);
  }
});

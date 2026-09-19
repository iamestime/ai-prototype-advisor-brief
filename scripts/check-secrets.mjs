import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const forbiddenPaths = tracked.filter((file) => {
  if (!existsSync(file)) return false;
  const name = file.split("/").at(-1) || file;
  return (
    name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example") ||
    /\.(?:pem|key|p12|pfx)$/i.test(name)
  );
});

const signatures = [
  ["Google API key", /AIza[0-9A-Za-z_-]{20,}/g],
  ["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  [
    "GitHub token",
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  ],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Stripe secret", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];

const findings = [];
for (const file of tracked) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }
  if (buffer.length > 1_500_000 || buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  for (const [label, pattern] of signatures) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${file}: ${label}`);
  }
}

if (forbiddenPaths.length || findings.length) {
  console.error("Secret hygiene check failed.");
  for (const file of forbiddenPaths) console.error(`- tracked runtime file: ${file}`);
  for (const finding of findings) console.error(`- possible credential: ${finding}`);
  process.exit(1);
}

console.log(
  `Secret hygiene check passed (${tracked.length} tracked files, no runtime env files or credential signatures).`,
);

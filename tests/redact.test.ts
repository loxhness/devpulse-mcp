import { describe, expect, it } from "vitest";
import { redact } from "../src/utils/redact.js";

describe("redact: secrets are removed", () => {
  const cases: Array<[string, string]> = [
    ["Bearer token", "Authorization: Bearer abc123def456"],
    ["JWT", "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"],
    ["GitHub PAT (classic)", "push failed with ghp_1234567890abcdefghijklmnopqrstuvwxyzAB"],
    ["GitHub fine-grained PAT", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
    ["AWS access key", "using AKIAIOSFODNN7EXAMPLE for s3"],
    ["Stripe live key", "stripe key sk_live_51Habcdefghijklmnop"],
    ["Anthropic key", "x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"],
    ["OpenAI project key", "sk-proj-abcdefghijklmnopqrstuvwxyz0123"],
    ["Slack token", "xoxb-1234567890-abcdefghij"],
    ["Google API key", "key=AIzaSyA1234567890abcdefghijklmnopqrstuv"],
    ["npm token", "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["URL credentials", "connect postgres://admin:hunter2pass@db.internal:5432/app"],
  ];

  for (const [label, input] of cases) {
    it(label, () => {
      const output = redact(input);
      expect(output).toContain("[REDACTED]");
    });
  }

  it("env-style assignments", () => {
    expect(redact("API_KEY=abc123")).toBe("API_KEY=[REDACTED]");
    expect(redact("DATABASE_PASSWORD='s3cr3t-value'")).toBe("DATABASE_PASSWORD='[REDACTED]'");
  });

  it("short values after '=' with no space (logfmt, query strings)", () => {
    expect(redact("db login password=hunter2 user=bob")).toBe("db login password=[REDACTED] user=bob");
    expect(redact("TOKEN=abc")).toBe("TOKEN=[REDACTED]");
    expect(redact("GET /cb?token=x1&state=ok")).toBe("GET /cb?token=[REDACTED]&state=ok");
    expect(redact("api_key=k9 secret=s")).toBe("api_key=[REDACTED] secret=[REDACTED]");
  });

  it("JSON key/value pairs", () => {
    expect(redact('{"password": "correcthorsebattery"}')).toBe('{"password": "[REDACTED]"}');
  });

  it("URL password but not the username or host", () => {
    expect(redact("postgres://admin:hunter2pass@db.internal:5432/app")).toBe(
      "postgres://admin:[REDACTED]@db.internal:5432/app"
    );
  });
});

describe("redact: debugging details survive", () => {
  const preserved = [
    "Error in src/db/user.service.ts line 40",
    "GET https://api.example.com/v1/users 500",
    "running next@14.2.3 on node 20.11.0",
    "HEAD is now at 3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c",
    "request id 550e8400e29b41d4a716446655440000",
    "token: expired",
    "password: invalid",
    "token = refresh pending",
    "auth: failed for user bob",
    "Cannot find module './components/Button.module.css'",
    "hello world",
  ];
  for (const line of preserved) {
    it(line, () => expect(redact(line)).toBe(line));
  }

  it("never throws on empty or undefined input", () => {
    expect(redact("")).toBe("");
    expect(() => redact(undefined as unknown as string)).not.toThrow();
  });
});

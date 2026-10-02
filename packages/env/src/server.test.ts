import { describe, expect, it } from "vitest";

import { serverSchema } from "./server";

const required = {
  DATABASE_URL: "postgresql://unused@127.0.0.1:5432/unused",
  BETTER_AUTH_SECRET: "test-only-secret-that-is-at-least-32-chars",
  BETTER_AUTH_URL: "http://localhost:3000",
};

const smtpUrl = "smtps://user:s3cr%40t-password@smtp.example.com:465";
const sender = "Startup Template <no-reply@example.com>";

function parse(email: { SMTP_URL?: string; EMAIL_FROM?: string }) {
  return serverSchema.safeParse({ ...required, ...email });
}

function errorText(email: { SMTP_URL?: string; EMAIL_FROM?: string }) {
  const result = parse(email);

  expect(result.success).toBe(false);

  return result.error?.message ?? "";
}

describe("email configuration", () => {
  it("is disabled when both variables are empty or unset", () => {
    for (const email of [{}, { SMTP_URL: "", EMAIL_FROM: "" }]) {
      const result = parse(email);

      expect(result.success).toBe(true);
      expect(result.data?.SMTP_URL).toBeUndefined();
      expect(result.data?.EMAIL_FROM).toBeUndefined();
    }
  });

  it("accepts a valid connection string and sender", () => {
    for (const from of [
      sender,
      "no-reply@example.com",
      "<no-reply@example.com>",
      '"Startup, Inc." <no-reply@example.com>',
    ]) {
      const result = parse({ SMTP_URL: smtpUrl, EMAIL_FROM: from });

      expect(result.success, from).toBe(true);
    }

    expect(
      parse({ SMTP_URL: "smtp://localhost:1025", EMAIL_FROM: sender }).success,
    ).toBe(true);
  });

  it("rejects one variable without the other and names the missing one", () => {
    const withoutSender = errorText({ SMTP_URL: smtpUrl });

    expect(withoutSender).toContain("EMAIL_FROM is required");
    expect(withoutSender).not.toContain("s3cr");

    const withoutUrl = errorText({ EMAIL_FROM: sender });

    expect(withoutUrl).toContain("SMTP_URL is required");
    expect(withoutUrl).not.toContain("no-reply@example.com");
  });

  it("rejects a connection string that is not an SMTP URL", () => {
    for (const value of [
      "not a url",
      "https://smtp.example.com",
      "smtp://",
      "smtp://smtp.example.com\r\nRCPT TO:<x@example.com>",
    ]) {
      expect(errorText({ SMTP_URL: value, EMAIL_FROM: sender })).toContain(
        "SMTP_URL",
      );
    }
  });

  it("rejects an invalid sender, including line breaks", () => {
    for (const value of [
      "not an address",
      "Startup Template no-reply@example.com",
      "Startup, Inc. <no-reply@example.com>",
      "Startup <no-reply@example.com>\r\nBcc: x@example.com",
      "no-reply@example.com\n",
    ]) {
      expect(errorText({ SMTP_URL: smtpUrl, EMAIL_FROM: value })).toContain(
        "EMAIL_FROM",
      );
    }
  });

  it("never includes a value in a validation error", () => {
    const message = errorText({
      SMTP_URL: "smtps://user:s3cr%40t-password@",
      EMAIL_FROM: sender,
    });

    expect(message).not.toContain("s3cr");
    expect(message).not.toContain("user:");
  });
});

describe("GitHub configuration", () => {
  function parseGitHub(github: { GITHUB_API_TOKEN?: string; GITHUB_API_URL?: string }) {
    return serverSchema.safeParse({ ...required, ...github });
  }

  it("is optional, and empty values are unset", () => {
    for (const github of [{}, { GITHUB_API_TOKEN: "", GITHUB_API_URL: "" }]) {
      const result = parseGitHub(github);

      expect(result.success).toBe(true);
      expect(result.data?.GITHUB_API_TOKEN).toBeUndefined();
      expect(result.data?.GITHUB_API_URL).toBeUndefined();
    }
  });

  it("accepts a token and an https API URL, or http on a loopback host", () => {
    for (const url of [
      "https://api.github.com",
      "https://github.example.com/api/v3",
      "http://127.0.0.1:9998",
      "http://localhost:9998",
    ]) {
      expect(parseGitHub({ GITHUB_API_TOKEN: "github_pat_example", GITHUB_API_URL: url }).success, url).toBe(true);
    }
  });

  it("rejects a token with spaces or line breaks, without echoing it", () => {
    for (const token of ["github_pat_s3cret value", "github_pat_s3cret\r\nX-Injected: 1"]) {
      const result = parseGitHub({ GITHUB_API_TOKEN: token });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("GITHUB_API_TOKEN");
      expect(result.error?.message).not.toContain("s3cret");
    }
  });

  it("rejects an API URL that is not https, or that carries credentials, a query, or a fragment", () => {
    for (const url of [
      "not a url",
      "http://api.github.com",
      "http://10.0.0.5:9998",
      "ftp://api.github.com",
      "https://user:pass@api.github.com",
      "https://api.github.com?x=1",
      "https://api.github.com#x",
    ]) {
      const result = parseGitHub({ GITHUB_API_URL: url });

      expect(result.success, url).toBe(false);
      expect(result.error?.message).toContain("GITHUB_API_URL");
    }
  });
});

describe("writing model configuration", () => {
  function parseModel(model: { ANTHROPIC_API_KEY?: string; ANTHROPIC_MODEL?: string }) {
    return serverSchema.safeParse({ ...required, ...model });
  }

  it("is disabled when both variables are empty or unset", () => {
    for (const model of [{}, { ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "" }]) {
      const result = parseModel(model);

      expect(result.success).toBe(true);
      expect(result.data?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.data?.ANTHROPIC_MODEL).toBeUndefined();
    }
  });

  it("accepts a key and a model together", () => {
    expect(parseModel({ ANTHROPIC_API_KEY: "sk-ant-test-key", ANTHROPIC_MODEL: "claude-opus-5-5" }).success).toBe(true);
  });

  it("rejects one variable without the other, naming the missing one and never the key", () => {
    const withoutModel = parseModel({ ANTHROPIC_API_KEY: "sk-ant-s3cret-key" });
    const withoutKey = parseModel({ ANTHROPIC_MODEL: "claude-opus-5-5" });

    expect(withoutModel.success).toBe(false);
    expect(withoutModel.error?.message).toContain("ANTHROPIC_MODEL is required when ANTHROPIC_API_KEY is set");
    expect(withoutModel.error?.message).toContain("the writing model");
    expect(withoutModel.error?.message).not.toContain("s3cret");
    expect(withoutKey.success).toBe(false);
    expect(withoutKey.error?.message).toContain("ANTHROPIC_API_KEY is required when ANTHROPIC_MODEL is set");
  });

  it("rejects a key or model with spaces or line breaks, without echoing it", () => {
    for (const value of ["sk-ant-s3cret key", "sk-ant-s3cret\nX-Injected: 1"]) {
      const result = parseModel({ ANTHROPIC_API_KEY: value, ANTHROPIC_MODEL: "claude-opus-5-5" });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("ANTHROPIC_API_KEY");
      expect(result.error?.message).not.toContain("s3cret");
    }
    expect(parseModel({ ANTHROPIC_API_KEY: "sk-ant-key", ANTHROPIC_MODEL: "claude opus" }).success).toBe(false);
  });
});

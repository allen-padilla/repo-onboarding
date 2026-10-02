import { z } from "zod";

import { emailFrom, smtpUrl } from "./email";
import { githubApiToken, githubApiUrl } from "./github";
import { printableToken } from "./printable";
import { optional } from "./optional";

// Optional integrations that need two values: setting one without the other
// is an error, so a half-configured integration fails at startup instead of
// silently staying disabled.
const PAIRS = [
  ["SMTP_URL", "EMAIL_FROM", "email"],
  ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "the writing model"],
] as const;

export const serverSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    DATABASE_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url(),

    // Billing is optional until a billing endpoint is invoked. @startup/billing
    // raises a configuration error when a required value is missing.
    STRIPE_SECRET_KEY: optional(z.string().regex(/^(sk|rk)_(test|live)_/)),
    STRIPE_WEBHOOK_SECRET: optional(z.string().startsWith("whsec_")),
    STRIPE_PRICE_PRO_MONTHLY: optional(z.string().startsWith("price_")),

    // Decision models are optional until a decision is evaluated.
    // @startup/decision raises a configuration error when a value is missing.
    TYPESAFE_API_KEY: optional(z.string().min(1)),
    TYPESAFE_MODEL: optional(z.string().min(1)),

    // Email is disabled when both are empty. Setting only one is an error.
    // @startup/email raises a configuration error when sending while disabled.
    SMTP_URL: optional(smtpUrl),
    EMAIL_FROM: optional(emailFrom),

    // GitHub works without a token. The token only raises rate limits, and
    // must not have access to private repositories. @startup/github defaults
    // the API URL to https://api.github.com; only tests change it.
    GITHUB_API_TOKEN: optional(githubApiToken),
    GITHUB_API_URL: optional(githubApiUrl),

    // The writing model is disabled when both are empty. Setting only one is
    // an error. @startup/generation raises a configuration error when it is
    // called while disabled.
    ANTHROPIC_API_KEY: optional(printableToken),
    ANTHROPIC_MODEL: optional(printableToken),
  })
  .superRefine((env, ctx) => {
    for (const [first, second, feature] of PAIRS) {
      const missing = env[first] ? (env[second] ? undefined : second) : env[second] ? first : undefined;
      if (!missing) continue;

      ctx.addIssue({
        code: "custom",
        path: [missing],
        message: `${missing} is required when ${
          missing === first ? second : first
        } is set. Set both to enable ${feature}, or leave both empty.`,
      });
    }
  });

export const serverEnv = serverSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  TYPESAFE_MODEL: process.env.TYPESAFE_MODEL,
  SMTP_URL: process.env.SMTP_URL,
  EMAIL_FROM: process.env.EMAIL_FROM,
  GITHUB_API_TOKEN: process.env.GITHUB_API_TOKEN,
  GITHUB_API_URL: process.env.GITHUB_API_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
});

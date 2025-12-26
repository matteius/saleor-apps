import { z } from "zod";

import { BaseError } from "@/lib/errors";

// Simple env validation for SMTP app
const envSchema = z.object({
  APL: z.enum(["saleor-cloud", "file", "dynamodb", "mongodb"]).optional().default("file"),
  MONGODB_URL: z.string().optional(),
  MONGODB_DATABASE: z.string().optional().default("saleor_smtp"),
  SECRET_KEY: z.string().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).optional().default("development"),
});

function getEnv() {
  const result = envSchema.safeParse({
    APL: process.env.APL,
    MONGODB_URL: process.env.MONGODB_URL,
    MONGODB_DATABASE: process.env.MONGODB_DATABASE,
    SECRET_KEY: process.env.SECRET_KEY,
    NODE_ENV: process.env.NODE_ENV,
  });

  if (!result.success) {
    const EnvValidationError = BaseError.subclass("EnvValidationError");

    throw new EnvValidationError("Environment validation failed", {
      cause: result.error,
    });
  }

  return result.data;
}

export const env = getEnv();

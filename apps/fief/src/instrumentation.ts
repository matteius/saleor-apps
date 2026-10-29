import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_ENABLED !== "false") {
    await import("./instrumentations/sentry-node");
  }
}
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.SENTRY_ENABLED !== "false") {
    const { captureRequestError } = await import("@sentry/nextjs");

    captureRequestError(...args);
  }
};

import { attachLoggerConsoleTransport, rootLogger } from "@saleor/apps-logger";

import { env } from "./env";

rootLogger.settings.maskValuesOfKeys = ["token", "secretKey", "apiKey"];

if (env.NODE_ENV === "development") {
  attachLoggerConsoleTransport(rootLogger);
}

if (typeof window === "undefined" && env.NODE_ENV === "production") {
  import("@saleor/apps-logger/node").then(({ attachLoggerVercelRuntimeTransport }) => {
    import("./logger-context").then(({ loggerContext }) => {
      attachLoggerVercelRuntimeTransport(rootLogger, "1.0.0", loggerContext);
    });
  });
}

export const createLogger = (name: string, params?: Record<string, unknown>) =>
  rootLogger.getSubLogger(
    {
      name: `ocr-credits/${name}`,
    },
    params,
  );


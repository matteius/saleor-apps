import { APL } from "@saleor/app-sdk/APL";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { RedisAPL } from "@saleor/app-sdk/APL/redis";
import { SaleorCloudAPL } from "@saleor/app-sdk/APL/saleor-cloud";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";
import { createClient } from "redis";

import { env } from "./env";
import { BaseError } from "./errors";

export let apl: APL;

const MisconfiguredAPLError = BaseError.subclass("MisconfiguredAPLError");

switch (env.APL) {
  case "redis": {
    if (!env.REDIS_URL) {
      throw new MisconfiguredAPLError("Redis APL is not configured - missing REDIS_URL env variable");
    }

    const redisClient = createClient({
      url: env.REDIS_URL,
    });

    apl = new RedisAPL({
      client: redisClient,
      hashCollectionKey: "saleor_ocr_credits_auth",
    });

    break;
  }

  case "saleor-cloud": {
    if (!env.REST_APL_ENDPOINT || !env.REST_APL_TOKEN) {
      throw new MisconfiguredAPLError(
        "Saleor Cloud APL is not configured - missing REST_APL_ENDPOINT or REST_APL_TOKEN",
      );
    }

    apl = new SaleorCloudAPL({
      resourceUrl: env.REST_APL_ENDPOINT,
      token: env.REST_APL_TOKEN,
    });

    break;
  }

  case "file":
  default:
    apl = new FileAPL({
      fileName: env.FILE_APL_PATH,
    });

    break;
}

export const saleorApp = new SaleorApp({
  apl,
});


import { APL } from "@saleor/app-sdk/APL";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { SaleorCloudAPL } from "@saleor/app-sdk/APL/saleor-cloud";
import { UpstashAPL } from "@saleor/app-sdk/APL/upstash";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";

import { MongoAPL } from "./modules/apl/mongodb-apl";

const aplType = process.env.APL || "file";

// Debug logging - only in development
if (process.env.NODE_ENV === "development") {
  // eslint-disable-next-line no-console
  console.log("SMTP App APL Configuration:");
  // eslint-disable-next-line no-console
  console.log("APL environment variable:", process.env.APL);
  // eslint-disable-next-line no-console
  console.log("Selected APL type:", aplType);
}

export let apl: APL;

switch (aplType) {
  case "upstash":
    apl = new UpstashAPL();

    break;

  case "file":
    apl = new FileAPL();

    break;

  case "mongodb": {
    apl = new MongoAPL();
    break;
  }

  case "saleor-cloud": {
    if (!process.env.REST_APL_ENDPOINT || !process.env.REST_APL_TOKEN) {
      throw new Error("Rest APL is not configured - missing env variables. Check saleor-app.ts");
    }

    apl = new SaleorCloudAPL({
      resourceUrl: process.env.REST_APL_ENDPOINT,
      token: process.env.REST_APL_TOKEN,
    });

    break;
  }

  default: {
    apl = new FileAPL();
    break;
  }
}

export const saleorApp = new SaleorApp({
  apl,
});

export const REQUIRED_SALEOR_VERSION = ">=3.11.7 <4";

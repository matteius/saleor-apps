import { SaleorApp } from "@saleor/app-sdk/saleor-app";

import { RedisAPL } from "./apl";

export let apl: RedisAPL;

apl = new RedisAPL({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

export const saleorApp = new SaleorApp({
  apl,
});

export const REQUIRED_SALEOR_VERSION = ">=3.11.7 <4";

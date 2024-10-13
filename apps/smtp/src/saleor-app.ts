import { RedisAPL } from "./apl";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";

export let apl: RedisAPL;

apl = new RedisAPL({
  url: process.env.REDIS_URL,
});

export const saleorApp = new SaleorApp({
  apl,
});

export const REQUIRED_SALEOR_VERSION = ">=3.11.7 <4";

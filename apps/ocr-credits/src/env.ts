import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    APL: z.enum(["file", "mongodb", "saleor-cloud"]).default("file"),
    FILE_APL_PATH: z.string().optional().default(".auth-data.json"),
    // MongoDB APL configuration
    MONGODB_URL: z.string().optional(),
    MONGODB_DATABASE: z.string().optional().default("saleor_ocr_credits"),
    // Saleor Cloud APL configuration
    REST_APL_ENDPOINT: z.string().optional(),
    REST_APL_TOKEN: z.string().optional(),
    MANIFEST_APP_ID: z.string().default("saleor.app.ocr-credits"),
    APP_API_BASE_URL: z.string().optional(),
    APP_IFRAME_BASE_URL: z.string().optional(),
    SECRET_KEY: z.string().optional(),
    // Demetered configuration
    DEMETERED_API_URL: z.string().default("http://demetered-api-service.whitewhale.svc.cluster.local"),
    DEMETERED_ADMIN_API_KEY: z.string().optional().default(""),
    DEMETERED_TENANT_ID: z.string().default("ten_opensensor"),
  },
  client: {},
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    APL: process.env.APL,
    FILE_APL_PATH: process.env.FILE_APL_PATH,
    MONGODB_URL: process.env.MONGODB_URL,
    MONGODB_DATABASE: process.env.MONGODB_DATABASE,
    REST_APL_ENDPOINT: process.env.REST_APL_ENDPOINT,
    REST_APL_TOKEN: process.env.REST_APL_TOKEN,
    MANIFEST_APP_ID: process.env.MANIFEST_APP_ID,
    APP_API_BASE_URL: process.env.APP_API_BASE_URL,
    APP_IFRAME_BASE_URL: process.env.APP_IFRAME_BASE_URL,
    SECRET_KEY: process.env.SECRET_KEY,
    DEMETERED_API_URL: process.env.DEMETERED_API_URL,
    DEMETERED_ADMIN_API_KEY: process.env.DEMETERED_ADMIN_API_KEY,
    DEMETERED_TENANT_ID: process.env.DEMETERED_TENANT_ID,
  },
});


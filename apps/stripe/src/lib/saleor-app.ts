import { APL } from "@saleor/app-sdk/APL";
import { DynamoAPL } from "@saleor/app-sdk/APL/dynamodb";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";

import { MongoAPL } from "@/modules/apl/mongodb-apl";
import { dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";

import { env } from "./env";

export let apl: APL;
switch (env.APL) {
  case "dynamodb": {
    apl = DynamoAPL.create({
      table: dynamoMainTable,
    });

    break;
  }

  case "mongodb": {
    apl = new MongoAPL();
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

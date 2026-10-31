import { AppBridgeProvider } from "@saleor/app-sdk/app-bridge";
import { GraphQLProvider } from "@saleor/apps-shared/graphql-provider";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";

test("shared GraphQL provider sees the Stripe app's App Bridge context", () => {
  /*
   * Use the real SDK and shared component: mocking either hides the duplicate
   * context created by pnpm's different peer dependency resolutions.
   */
  expect(
    renderToString(
      createElement(
        AppBridgeProvider,
        null,
        createElement(GraphQLProvider, null, "Stripe application"),
      ),
    ),
  ).toContain("Stripe application");
});

/**
 * Next.js Pages Router app shell for the Fief Saleor App (T35).
 *
 * Structurally identical to `apps/stripe/src/pages/_app.tsx`:
 *
 *   - Iframe-protected (the dashboard renders this app inside an iframe;
 *     directly visiting the URL outside the dashboard returns the
 *     `IframeProtectedFallback`)
 *   - AppBridge singleton from `trpc-client.ts` (re-exported here so the
 *     `apps/stripe`-style import path keeps working)
 *   - Theme + RoutePropagator + the tRPC HOC
 */
import "@saleor/macaw-ui/style";

import { AppBridgeProvider } from "@saleor/app-sdk/app-bridge";
import { RoutePropagator } from "@saleor/app-sdk/app-bridge/next";
import { IframeProtectedFallback } from "@saleor/apps-shared/iframe-protected-fallback";
import { IframeProtectedWrapper } from "@saleor/apps-shared/iframe-protected-wrapper";
import { NoSSRWrapper } from "@saleor/apps-shared/no-ssr-wrapper";
import { ThemeSynchronizer } from "@saleor/apps-shared/theme-synchronizer";
import { Box, ThemeProvider } from "@saleor/macaw-ui";
import { type AppProps } from "next/app";

import { appBridgeInstance, trpcClient } from "@/modules/trpc/trpc-client";

function NextApp({ Component, pageProps }: AppProps) {
  return (
    <NoSSRWrapper>
      <ThemeProvider>
        <IframeProtectedWrapper
          allowedPathNames={["/"]}
          fallback={<IframeProtectedFallback appName="Saleor Fief App" />}
        >
          <AppBridgeProvider appBridgeInstance={appBridgeInstance}>
            <ThemeSynchronizer />
            <RoutePropagator />
            <Box padding={10}>
              <Component {...pageProps} />
            </Box>
          </AppBridgeProvider>
        </IframeProtectedWrapper>
      </ThemeProvider>
    </NoSSRWrapper>
  );
}

export default trpcClient.withTRPC(NextApp);

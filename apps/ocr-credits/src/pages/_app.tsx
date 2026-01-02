import "@saleor/macaw-ui/style";

import { AppBridge, AppBridgeProvider } from "@saleor/app-sdk/app-bridge";
import { RoutePropagator } from "@saleor/app-sdk/app-bridge/next";
import { ThemeProvider } from "@saleor/macaw-ui";
import { AppProps } from "next/app";

/**
 * This is a minimal app shell - the OCR Credits app is primarily a webhook handler
 * and doesn't need a complex UI.
 */

const appBridgeInstance =
  typeof window !== "undefined" ? new AppBridge() : undefined;

function App({ Component, pageProps }: AppProps) {
  return (
    <AppBridgeProvider appBridgeInstance={appBridgeInstance}>
      <ThemeProvider>
        <RoutePropagator />
        <Component {...pageProps} />
      </ThemeProvider>
    </AppBridgeProvider>
  );
}

export default App;


/**
 * T25: Saleor Dashboard config UI for Stripe-price ↔ Saleor-variant mapping.
 *
 * Pages-Router route: `/subscriptions` (drawer-accessible from the Saleor
 * admin app shell). Mirrors the existing `/config` page shape (AppHeader +
 * Layout.AppSection + a section component) so the look-and-feel matches the
 * rest of the Stripe app.
 */
import { Layout } from "@saleor/apps-ui";
import { Box, Text } from "@saleor/macaw-ui";
import { type NextPage } from "next";

import { AppHeader } from "@/modules/ui/app-header";
import { PriceVariantMappingsSection } from "@/modules/ui/price-variant-mappings/price-variant-mappings-section";
import { useHasAppAccess } from "@/modules/ui/use-has-app-access";

const SubscriptionsConfigPage: NextPage = () => {
  const { haveAccessToApp } = useHasAppAccess();

  if (!haveAccessToApp) {
    return <Text>You do not have permission to access this page.</Text>;
  }

  return (
    <Box>
      <AppHeader />
      <Layout.AppSection
        marginBottom={14}
        heading="Subscription price mapping"
        sideContent={
          <Box display="flex" flexDirection="column" gap={4}>
            <Text>
              Map each Stripe subscription price to the Saleor product variant that should be used
              when an invoice is paid.
            </Text>
            <Text>
              When a customer is charged for a recurring invoice, the Stripe app uses this mapping
              to draft a Saleor order with the correct variant in the chosen channel.
            </Text>
          </Box>
        }
      >
        <PriceVariantMappingsSection />
      </Layout.AppSection>
    </Box>
  );
};

export default SubscriptionsConfigPage;

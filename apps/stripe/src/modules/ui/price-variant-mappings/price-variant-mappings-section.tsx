/**
 * Section that fetches the price-variant mappings and renders the list
 * (read state) or the inline form (add state). Mirrors the
 * `ChannelConfigSection` shape used on the existing dashboard config page.
 */
import { Layout } from "@saleor/apps-ui";
import { Skeleton, Text } from "@saleor/macaw-ui";
import { useEffect, useState } from "react";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { PriceVariantMappingForm } from "./price-variant-mapping-form";
import { PriceVariantMappingsList } from "./price-variant-mappings-list";

export const PriceVariantMappingsSection = () => {
  const [showForm, setShowForm] = useState(false);
  const utils = trpcClient.useContext();
  const { data, error, refetch } = trpcClient.subscriptions.listMappings.useQuery();

  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only refetch, mirrors `ChannelConfigSection`
  }, []);

  if (error) {
    return <Text color="critical1">Error loading mappings: {error.message}</Text>;
  }

  if (!data) {
    return (
      <Layout.AppSectionCard footer={<Skeleton />}>
        <Skeleton />
      </Layout.AppSectionCard>
    );
  }

  return (
    <>
      {showForm && (
        <PriceVariantMappingForm
          onSaved={() => {
            setShowForm(false);
            void utils.subscriptions.listMappings.invalidate();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}
      <PriceVariantMappingsList mappings={data.mappings} onAddClick={() => setShowForm(true)} />
    </>
  );
};

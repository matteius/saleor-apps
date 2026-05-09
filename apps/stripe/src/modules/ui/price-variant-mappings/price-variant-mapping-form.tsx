/**
 * Inline form to add a new Stripe-price ↔ Saleor-variant mapping.
 *
 * Three plain text inputs (no `<form>` validator library — the tRPC handler
 * is the source of truth via Zod, so we surface server errors in the
 * dashboard notification toast). Mirrors the "create a new config"
 * affordance in `stripe-configs/new-stripe-config-form.tsx` but kept inline
 * (no separate page) per T25 plan.
 */
import { useDashboardNotification } from "@saleor/apps-shared/use-dashboard-notification";
import { Box, Button, Input, Text } from "@saleor/macaw-ui";
import { useState } from "react";

import { trpcClient } from "@/modules/trpc/trpc-client";

type Props = {
  onSaved(): void;
  onCancel(): void;
};

export const PriceVariantMappingForm = ({ onSaved, onCancel }: Props) => {
  const { notifyError, notifySuccess } = useDashboardNotification();
  const [stripePriceId, setStripePriceId] = useState("");
  const [saleorVariantId, setSaleorVariantId] = useState("");
  const [saleorChannelSlug, setSaleorChannelSlug] = useState("");

  const { mutate, isLoading } = trpcClient.subscriptions.upsertMapping.useMutation({
    onSuccess() {
      notifySuccess("Mapping saved");
      setStripePriceId("");
      setSaleorVariantId("");
      setSaleorChannelSlug("");
      onSaved();
    },
    onError(err) {
      notifyError("Error saving mapping", err.message);
    },
  });

  const canSubmit =
    stripePriceId.trim().length > 0 &&
    saleorVariantId.trim().length > 0 &&
    saleorChannelSlug.trim().length > 0 &&
    !isLoading;

  return (
    <Box
      display="flex"
      flexDirection="column"
      gap={4}
      padding={6}
      borderWidth={1}
      borderStyle="solid"
      borderColor="default1"
      borderRadius={3}
      marginBottom={6}
    >
      <Text size={4} fontWeight="bold">
        Add new mapping
      </Text>
      <Input
        label="Stripe Price ID"
        helperText='Stripe price identifier, e.g. "price_1ABC..."'
        value={stripePriceId}
        onChange={(e) => setStripePriceId(e.target.value)}
      />
      <Input
        label="Saleor Variant ID"
        helperText='Saleor product-variant ID, e.g. "UHJvZHVjdFZhcmlhbnQ6MQ=="'
        value={saleorVariantId}
        onChange={(e) => setSaleorVariantId(e.target.value)}
      />
      <Input
        label="Saleor Channel Slug"
        helperText='Channel slug to mint the order in, e.g. "default-channel"'
        value={saleorChannelSlug}
        onChange={(e) => setSaleorChannelSlug(e.target.value)}
      />
      <Box display="flex" justifyContent="flex-end" gap={3}>
        <Button variant="tertiary" onClick={onCancel} disabled={isLoading}>
          Cancel
        </Button>
        <Button
          disabled={!canSubmit}
          onClick={() =>
            mutate({
              stripePriceId: stripePriceId.trim(),
              saleorVariantId: saleorVariantId.trim(),
              saleorChannelSlug: saleorChannelSlug.trim(),
            })
          }
        >
          {isLoading ? "Saving..." : "Save"}
        </Button>
      </Box>
    </Box>
  );
};

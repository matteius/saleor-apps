/**
 * List view of Stripe-price ↔ Saleor-variant mappings.
 *
 * Renders a table-like layout (rows of Box flexes — Macaw doesn't ship a
 * full-blown DataTable, and the existing config UI in this app uses the
 * same flex-row pattern). Each row has a "Delete" button that opens a
 * confirmation modal (reuses the same `DeleteConfigurationModalContent`
 * pattern as `stripe-configs/stripe-configs-list.tsx`).
 */
import { useDashboardNotification } from "@saleor/apps-shared/use-dashboard-notification";
import { Layout } from "@saleor/apps-ui";
import { Box, Button, Modal, Text, TrashBinIcon } from "@saleor/macaw-ui";
import { useState } from "react";

import { trpcClient } from "@/modules/trpc/trpc-client";
import { DeleteConfigurationModalContent } from "@/modules/ui/stripe-configs/delete-configuration-modal-content";

type Mapping = {
  stripePriceId: string;
  saleorVariantId: string;
  saleorChannelSlug: string;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  mappings: Mapping[];
  onAddClick(): void;
};

export const PriceVariantMappingsList = ({ mappings, onAddClick }: Props) => {
  const { notifyError, notifySuccess } = useDashboardNotification();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const utils = trpcClient.useContext();

  const { mutate: deleteMapping, isLoading } = trpcClient.subscriptions.deleteMapping.useMutation({
    onSuccess() {
      notifySuccess("Mapping deleted");
    },
    onError(err) {
      notifyError("Error deleting mapping", err.message);
    },
    onSettled() {
      void utils.subscriptions.listMappings.invalidate();
    },
  });

  return (
    <Layout.AppSectionCard
      footer={
        <Box display="flex" justifyContent="flex-end">
          <Button onClick={onAddClick}>Add mapping</Button>
        </Box>
      }
    >
      <Box>
        <Modal open={pendingDelete !== null} onChange={() => setPendingDelete(null)}>
          <DeleteConfigurationModalContent
            onDeleteClick={() => {
              if (!pendingDelete) {
                throw new Error("Invariant: modal open without pendingDelete");
              }
              deleteMapping({ stripePriceId: pendingDelete });
              setPendingDelete(null);
            }}
          />
        </Modal>

        {/* Header row */}
        <Box
          display="grid"
          paddingY={3}
          gap={3}
          borderBottomWidth={1}
          borderBottomStyle="solid"
          borderColor="default1"
          __gridTemplateColumns="2fr 2fr 1fr 80px"
        >
          <Text size={2} color="default2" fontWeight="bold">
            Stripe Price ID
          </Text>
          <Text size={2} color="default2" fontWeight="bold">
            Saleor Variant ID
          </Text>
          <Text size={2} color="default2" fontWeight="bold">
            Saleor Channel
          </Text>
          <Text size={2} color="default2" fontWeight="bold">
            Actions
          </Text>
        </Box>

        {mappings.length === 0 ? (
          <Box paddingY={6}>
            <Text color="default2">
              No mappings yet. Click {"“"}Add mapping{"”"} to create one.
            </Text>
          </Box>
        ) : (
          mappings.map((m) => (
            <Box
              key={m.stripePriceId}
              display="grid"
              paddingY={4}
              gap={3}
              alignItems="center"
              borderBottomWidth={1}
              borderBottomStyle="solid"
              borderColor="default1"
              __gridTemplateColumns="2fr 2fr 1fr 80px"
            >
              <Text>{m.stripePriceId}</Text>
              <Text>{m.saleorVariantId}</Text>
              <Text>{m.saleorChannelSlug}</Text>
              <Box display="flex" justifyContent="flex-start">
                <Button
                  variant="secondary"
                  icon={<TrashBinIcon />}
                  disabled={isLoading}
                  onClick={() => setPendingDelete(m.stripePriceId)}
                />
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Layout.AppSectionCard>
  );
};

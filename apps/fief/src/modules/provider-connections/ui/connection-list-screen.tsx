/**
 * T35 — `<ConnectionListScreen />`.
 *
 * Lists provider connections returned by `connections.list` (T34) with
 * status badges and per-row controls (rotate / edit / delete).
 *
 *   - Active                  — `softDeletedAt === null` and no pending secrets
 *   - Pending rotation        — `secrets.hasPendingClientSecret || hasPendingWebhookSecret`
 *   - Soft-deleted            — `softDeletedAt !== null`
 *
 * Delete uses the shared `<DeleteConfigurationModalContent />` so the
 * confirm-then-act pattern matches every other Saleor app.
 *
 * IMPORTANT — secret display invariant
 * ------------------------------------
 *
 *   The component reads ONLY the `secrets.has*` boolean flags returned by
 *   `redactProviderConnection` in T34. It never reaches into encrypted
 *   ciphertext, never decrypts, and never displays plaintext. This is
 *   asserted in `connection-list-screen.test.tsx`.
 */
import { useDashboardNotification } from "@saleor/apps-shared/use-dashboard-notification";
import { Box, Button, Chip, Modal, Skeleton, Text, TrashBinIcon } from "@saleor/macaw-ui";
import { useState } from "react";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { type RedactedProviderConnection } from "../trpc-router";

type ConnectionStatus = "active" | "pending-rotation" | "soft-deleted";

const computeStatus = (connection: RedactedProviderConnection): ConnectionStatus => {
  if (connection.softDeletedAt !== null) {
    return "soft-deleted";
  }
  if (connection.secrets.hasPendingClientSecret || connection.secrets.hasPendingWebhookSecret) {
    return "pending-rotation";
  }

  return "active";
};

const StatusBadge = ({ status }: { status: ConnectionStatus }) => {
  if (status === "soft-deleted") {
    return (
      <Chip data-testid="status-badge-soft-deleted" size="large">
        <Text size={1} color="default2">
          Soft-deleted
        </Text>
      </Chip>
    );
  }
  if (status === "pending-rotation") {
    return (
      <Chip
        data-testid="status-badge-pending-rotation"
        size="large"
        __backgroundColor="#CC4B00"
        borderColor="transparent"
      >
        <Text size={1} __color="#FFF">
          Pending rotation
        </Text>
      </Chip>
    );
  }

  return (
    <Chip data-testid="status-badge-active" size="large">
      <Text size={1} color="default1">
        Active
      </Text>
    </Chip>
  );
};

const DeleteConfirmModal = ({
  open,
  onClose,
  onConfirm,
  isDeleting,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
}) => {
  return (
    <Modal open={open} onChange={(next) => (next ? undefined : onClose())}>
      <Modal.Content>
        <Box
          backgroundColor="default1"
          boxShadow="defaultModal"
          __left="50%"
          __top="50%"
          position="fixed"
          __maxWidth="600px"
          __width="calc(100% - 64px)"
          __transform="translate(-50%, -50%)"
          padding={6}
          display="grid"
          gap={3}
          borderRadius={4}
        >
          <Text size={6} fontWeight="bold">
            Delete connection
          </Text>
          <Text>
            Soft-deletes the connection and removes the Fief OIDC client + webhook subscriber. The
            local row is preserved for audit. Are you sure?
          </Text>
          <Box display="flex" justifyContent="flex-end" gap={3}>
            <Button variant="secondary" onClick={onClose} disabled={isDeleting}>
              Cancel
            </Button>
            <Button
              variant="error"
              onClick={onConfirm}
              disabled={isDeleting}
              data-testid="confirm-delete-connection"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </Box>
        </Box>
      </Modal.Content>
    </Modal>
  );
};

export interface ConnectionListScreenProps {
  onCreateNew: () => void;
  onEdit: (connectionId: string) => void;
  onRotate: (connectionId: string) => void;
}

export const ConnectionListScreen = (props: ConnectionListScreenProps) => {
  const { onCreateNew, onEdit, onRotate } = props;
  const { notifySuccess, notifyError } = useDashboardNotification();
  const listQuery = trpcClient.connections.list.useQuery();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const deleteMutation = trpcClient.connections.delete.useMutation({
    onSuccess() {
      notifySuccess("Connection deleted");
      setPendingDeleteId(null);
      listQuery.refetch?.();
    },
    onError(err) {
      notifyError("Failed to delete connection", err.message);
    },
  });

  if (listQuery.isFetching && !listQuery.isFetched) {
    return (
      <Box data-testid="connection-list-loading" padding={6}>
        <Skeleton />
      </Box>
    );
  }

  const connections = listQuery.data ?? [];

  if (connections.length === 0) {
    return (
      <Box
        display="flex"
        flexDirection="column"
        gap={6}
        alignItems="center"
        padding={10}
        data-testid="connection-list-empty"
      >
        <Text>No Fief connections configured yet.</Text>
        <Button onClick={onCreateNew} data-testid="add-first-connection-button">
          Add first connection
        </Button>
      </Box>
    );
  }

  return (
    <Box display="flex" flexDirection="column" gap={4} data-testid="connection-list">
      {connections.map((connection) => {
        const status = computeStatus(connection);
        const isPending = status === "pending-rotation";
        const isSoftDeleted = status === "soft-deleted";

        return (
          <Box
            key={connection.id}
            padding={5}
            borderWidth={1}
            borderStyle="solid"
            borderColor="default1"
            borderRadius={3}
            display="flex"
            flexDirection="column"
            gap={3}
            data-testid={`connection-row-${connection.id}`}
          >
            <Box display="flex" justifyContent="space-between" alignItems="center" gap={4}>
              <Box display="flex" flexDirection="column" gap={1}>
                <Text fontWeight="bold" size={4}>
                  {connection.name}
                </Text>
                <Text size={2} color="default2">
                  {connection.fief.baseUrl} - tenant {connection.fief.tenantId}
                </Text>
              </Box>
              <StatusBadge status={status} />
            </Box>

            <Box display="flex" gap={3} justifyContent="flex-end" flexWrap="wrap">
              <Button
                variant="tertiary"
                onClick={() => onRotate(connection.id)}
                disabled={isSoftDeleted}
                data-testid={`rotate-connection-${connection.id}`}
              >
                {isPending ? "Continue rotation" : "Rotate secret"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => onEdit(connection.id)}
                disabled={isSoftDeleted}
                data-testid={`edit-connection-${connection.id}`}
              >
                Edit
              </Button>
              <Button
                variant="secondary"
                icon={<TrashBinIcon />}
                onClick={() => setPendingDeleteId(connection.id)}
                disabled={isSoftDeleted}
                data-testid={`delete-connection-${connection.id}`}
              />
            </Box>
          </Box>
        );
      })}

      <Box display="flex" justifyContent="flex-end">
        <Button onClick={onCreateNew} data-testid="add-connection-button">
          Add connection
        </Button>
      </Box>

      <DeleteConfirmModal
        open={pendingDeleteId !== null}
        onClose={() => setPendingDeleteId(null)}
        isDeleting={deleteMutation.isLoading}
        onConfirm={() => {
          if (pendingDeleteId === null) return;
          deleteMutation.mutate({ id: pendingDeleteId });
        }}
      />
    </Box>
  );
};

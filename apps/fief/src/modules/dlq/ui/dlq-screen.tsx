/**
 * T37 — `<DlqScreen />`.
 *
 * Lists DLQ entries returned by `dlq.list` (T37) and lets the operator
 * trigger replay via `dlq.replay` (T51).
 *
 * Per-row "Replay" button is DISABLED when the bound connection has been
 * soft-deleted (R12). The disable is enforced at TWO points:
 *
 *   1. **Initial render**: any entry whose `connectionId` resolves to a
 *      soft-deleted connection in the `connections.list` data has the
 *      button disabled with the tooltip
 *      "Connection deleted; restore or hard-delete this entry".
 *
 *   2. **Replay-time error**: a time-of-check / time-of-use window exists where the connection
 *      could be deleted between the initial fetch and the operator's
 *      click. The server returns `connection_deleted:` in the error
 *      message; the UI captures the error and adds the entry to a local
 *      `disabledIds` set, flipping the button to disabled with the same
 *      tooltip until the next refetch.
 */
import { useDashboardNotification } from "@saleor/apps-shared/use-dashboard-notification";
import { Box, Button, Chip, Skeleton, Text } from "@saleor/macaw-ui";
import { useState } from "react";

import { type RedactedProviderConnection } from "@/modules/provider-connections/trpc-router";
import { trpcClient } from "@/modules/trpc/trpc-client";

const DELETED_TOOLTIP = "Connection deleted; restore or hard-delete this entry";

const StatusChip = ({ status }: { status: "ok" | "retrying" | "dead" }) => {
  if (status === "dead") {
    return (
      <Chip
        data-testid="dlq-status-chip-dead"
        __backgroundColor="#A0001A"
        borderColor="transparent"
        size="large"
      >
        <Text size={1} __color="#FFF">
          dead
        </Text>
      </Chip>
    );
  }

  return (
    <Chip data-testid="dlq-status-chip" size="large">
      <Text size={1} color="default1">
        {status}
      </Text>
    </Chip>
  );
};

interface ReplayButtonProps {
  rowId: string;
  disabled: boolean;
  reason?: string;
  onClick: () => void;
  isLoading: boolean;
}

/**
 * Replay button + a wrapper carrying the tooltip via `title=` so the
 * disabled-state hint is reachable even when the button itself can't
 * receive pointer events. The wrapper has its own `data-testid` so tests
 * can read the tooltip without depending on the disabled `<button>`'s
 * (skipped) hover behavior.
 */
const ReplayButton = ({ rowId, disabled, reason, onClick, isLoading }: ReplayButtonProps) => (
  <Box
    data-testid={`dlq-replay-tooltip-${rowId}`}
    title={disabled && reason !== undefined ? reason : ""}
    display="inline-block"
  >
    <Button
      variant="primary"
      onClick={onClick}
      disabled={disabled || isLoading}
      data-testid={`dlq-replay-${rowId}`}
    >
      {isLoading ? "Replaying..." : "Replay"}
    </Button>
  </Box>
);

const isSoftDeleted = (connection: RedactedProviderConnection | undefined): boolean =>
  connection !== undefined && connection.softDeletedAt !== null;

export const DlqScreen = () => {
  const { notifySuccess, notifyError } = useDashboardNotification();
  const connectionsQuery = trpcClient.connections.list.useQuery();
  const listQuery = trpcClient.dlq.list.useQuery({});

  /*
   * Track entries the server reports as `connection_deleted` between
   * the initial render and a replay click — covers the time-of-check / time-of-use window
   * where the bound connection got deleted after we fetched the row.
   * Cleared on a successful refetch (the entry will either be gone or
   * re-classified by the connection-list refresh).
   */
  const [disabledIds, setDisabledIds] = useState<Set<string>>(new Set());

  const replayMutation = trpcClient.dlq.replay.useMutation({
    onSuccess() {
      notifySuccess("DLQ entry replayed");
      listQuery.refetch?.();
    },
    onError(err, variables) {
      const message = err.message ?? "";
      const targetId = (variables as { dlqEntryId?: string } | undefined)?.dlqEntryId;

      if (message.includes("connection_deleted")) {
        /*
         * Server confirmed the bound connection is soft-deleted /
         * missing. Pin the row's id to the disabled set so the button
         * stays disabled with the tooltip until a refetch.
         */
        notifyError("Replay refused", DELETED_TOOLTIP);
        if (typeof targetId === "string" && targetId.length > 0) {
          setDisabledIds((prev) => {
            const next = new Set(prev);

            next.add(targetId);

            return next;
          });
        }
      } else {
        notifyError("Replay failed", message);
      }
    },
  });

  const onClickReplay = (rowId: string) => {
    replayMutation.mutate({ dlqEntryId: rowId });
  };

  const isLoading =
    (listQuery.isFetching && !listQuery.isFetched) ||
    (connectionsQuery.isFetching && !connectionsQuery.isFetched);

  if (isLoading) {
    return (
      <Box padding={6} data-testid="dlq-loading">
        <Skeleton />
      </Box>
    );
  }

  const rows = listQuery.data?.rows ?? [];
  const connections = connectionsQuery.data ?? [];
  const connectionsById = new Map(connections.map((c) => [c.id, c]));

  if (rows.length === 0) {
    return (
      <Box padding={8} data-testid="dlq-empty">
        <Text size={5} fontWeight="bold">
          DLQ is empty
        </Text>
        <Text marginTop={2}>No dead-letter entries for this install. </Text>
      </Box>
    );
  }

  return (
    <Box display="flex" flexDirection="column" gap={3} data-testid="dlq-screen">
      <Box display="flex" justifyContent="space-between" alignItems="center">
        <Box display="flex" flexDirection="column" gap={1}>
          <Text size={5} fontWeight="bold">
            Dead-letter queue
          </Text>
          <Text size={2} color="default2">
            Webhook events that exhausted their retry budget. Replay re-runs the original dispatch
            path; replay against a soft-deleted connection is refused.
          </Text>
        </Box>
        <Button variant="tertiary" onClick={() => listQuery.refetch?.()} data-testid="dlq-refresh">
          Refresh
        </Button>
      </Box>

      <Box display="flex" flexDirection="column" gap={3}>
        {rows.map((row) => {
          const connection = connectionsById.get(row.connectionId);
          const softDeleted = isSoftDeleted(connection);
          const previouslyRefused = disabledIds.has(row.id);
          const disabled = softDeleted || previouslyRefused;
          const reason = disabled ? DELETED_TOOLTIP : undefined;

          return (
            <Box
              key={row.id}
              padding={5}
              borderWidth={1}
              borderStyle="solid"
              borderColor="default1"
              borderRadius={3}
              display="flex"
              flexDirection="column"
              gap={2}
              data-testid={`dlq-row-${row.id}`}
            >
              <Box display="flex" gap={4} alignItems="center" justifyContent="space-between">
                <Box display="flex" flexDirection="column" gap={1}>
                  <Text fontWeight="bold" size={3}>
                    {row.eventType}
                  </Text>
                  <Text size={2} color="default2">
                    {row.direction === "fief_to_saleor" ? "Fief -> Saleor" : "Saleor -> Fief"}
                  </Text>
                  <Text size={1} color="default2">
                    Connection: {connection?.name ?? row.connectionId}
                    {softDeleted ? " (soft-deleted)" : ""}
                  </Text>
                </Box>
                <StatusChip status={row.status} />
              </Box>

              <Box display="flex" gap={4} flexWrap="wrap">
                <Text size={1} color="default2">
                  event id: {row.eventId}
                </Text>
                <Text size={1} color="default2">
                  attempts: {row.attempts}
                </Text>
                <Text size={1} color="default2">
                  {row.movedToDlqAt}
                </Text>
              </Box>

              {row.lastError !== undefined && row.lastError.length > 0 ? (
                <Box backgroundColor="critical1" padding={3} borderRadius={3}>
                  <Text size={1} color="critical1">
                    last error: {row.lastError}
                  </Text>
                </Box>
              ) : null}

              <Box display="flex" justifyContent="flex-end">
                <ReplayButton
                  rowId={row.id}
                  disabled={disabled}
                  reason={reason}
                  onClick={() => onClickReplay(row.id)}
                  isLoading={replayMutation.isLoading}
                />
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

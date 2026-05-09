/**
 * T37 — `<WebhookHealthScreen />`.
 *
 * Paginated list of recent webhook events with filters for direction +
 * status + per-connection scope. "View payload" expands an inline panel
 * and lazily fetches the redacted JSON via `webhookLog.getPayload`.
 *
 * Two read sources via tRPC:
 *   - `webhookLog.list({...})` — header-only rows
 *   - `webhookLog.getPayload({ id })` — fetched on demand when the
 *     operator clicks "View payload"
 *
 * The screen never renders ciphertext (the repo never stores it) — the
 * `payloadRedacted` shape is whatever the receiver projected through
 * `redactFiefSecrets` (T50) before it was persisted.
 */
import { useDashboardNotification } from "@saleor/apps-shared/use-dashboard-notification";
import { Box, Button, Chip, Skeleton, Text } from "@saleor/macaw-ui";
import { useState } from "react";

import { trpcClient } from "@/modules/trpc/trpc-client";

type DirectionFilter = "all" | "fief_to_saleor" | "saleor_to_fief";
type StatusFilter = "all" | "ok" | "retrying" | "dead";
type ConnectionFilter = string; // empty string == "all"

const Select = ({
  id,
  value,
  onChange,
  options,
  testId,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  testId?: string;
}) => (
  <Box
    as="select"
    id={id}
    data-testid={testId}
    value={value}
    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
    padding={3}
    borderRadius={3}
    borderWidth={1}
    borderStyle="solid"
    borderColor="default1"
  >
    {options.map((opt) => (
      <option key={opt.value} value={opt.value}>
        {opt.label}
      </option>
    ))}
  </Box>
);

const StatusChip = ({ status }: { status: "ok" | "retrying" | "dead" }) => {
  if (status === "dead") {
    return (
      <Chip
        data-testid={`webhook-status-chip-dead`}
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
  if (status === "retrying") {
    return (
      <Chip
        data-testid={`webhook-status-chip-retrying`}
        __backgroundColor="#CC4B00"
        borderColor="transparent"
        size="large"
      >
        <Text size={1} __color="#FFF">
          retrying
        </Text>
      </Chip>
    );
  }

  return (
    <Chip data-testid={`webhook-status-chip-ok`} size="large">
      <Text size={1} color="default1">
        ok
      </Text>
    </Chip>
  );
};

const DirectionLabel = ({ direction }: { direction: "fief_to_saleor" | "saleor_to_fief" }) => (
  <Text size={2} color="default2">
    {direction === "fief_to_saleor" ? "Fief -> Saleor" : "Saleor -> Fief"}
  </Text>
);

interface PayloadPanelProps {
  rowId: string;
  payload: unknown;
}

const PayloadPanel = ({ rowId, payload }: PayloadPanelProps) => (
  <Box
    data-testid={`webhook-log-payload-${rowId}`}
    backgroundColor="default2"
    padding={4}
    borderRadius={3}
    marginTop={3}
  >
    <pre
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "monospace",
        fontSize: "12px",
        margin: 0,
      }}
    >
      {JSON.stringify(payload, null, 2)}
    </pre>
  </Box>
);

export const WebhookHealthScreen = () => {
  const { notifyError } = useDashboardNotification();
  const connectionsQuery = trpcClient.connections.list.useQuery();

  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [connectionId, setConnectionId] = useState<ConnectionFilter>("");
  const [limit] = useState<number>(50);

  /*
   * `useQuery` re-runs whenever the input shape changes; this is how the
   * tests verify the filter wiring (they read the most-recent call args).
   */
  const listQuery = trpcClient.webhookLog.list.useQuery({
    ...(direction !== "all" ? { direction } : {}),
    ...(status !== "all" ? { status } : {}),
    ...(connectionId.length > 0 ? { connectionId } : {}),
    limit,
  });

  const getPayloadMutation = trpcClient.webhookLog.getPayload.useMutation();

  const [expandedById, setExpandedById] = useState<Record<string, unknown>>({});

  const togglePayload = async (id: string) => {
    if (id in expandedById) {
      const { [id]: _drop, ...rest } = expandedById;

      setExpandedById(rest);

      return;
    }
    try {
      const res = await getPayloadMutation.mutateAsync({ id });

      setExpandedById((prev) => ({ ...prev, [id]: res.payloadRedacted }));
    } catch (err) {
      notifyError("Failed to load payload", (err as { message?: string })?.message ?? "");
    }
  };

  const isLoading = listQuery.isFetching && !listQuery.isFetched;
  const rows = listQuery.data?.rows ?? [];
  const connections = connectionsQuery.data ?? [];

  const directionOptions: Array<{ value: DirectionFilter; label: string }> = [
    { value: "all", label: "All directions" },
    { value: "fief_to_saleor", label: "Fief -> Saleor" },
    { value: "saleor_to_fief", label: "Saleor -> Fief" },
  ];
  const statusOptions: Array<{ value: StatusFilter; label: string }> = [
    { value: "all", label: "All statuses" },
    { value: "ok", label: "ok" },
    { value: "retrying", label: "retrying" },
    { value: "dead", label: "dead" },
  ];
  const connectionOptions: Array<{ value: string; label: string }> = [
    { value: "", label: "All connections" },
    ...connections.map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <Box display="flex" flexDirection="column" gap={6} data-testid="webhook-health-screen">
      <Box display="flex" flexDirection="column" gap={3}>
        <Text size={5} fontWeight="bold">
          Webhook health
        </Text>
        <Text size={2} color="default2">
          Recent webhook events for this Saleor install. Filter by direction, status, or specific
          connection. Click View payload to load the redacted JSON inline.
        </Text>
      </Box>

      <Box display="flex" gap={3} flexWrap="wrap" alignItems="center">
        <Box display="flex" flexDirection="column" gap={1}>
          <Text size={1} color="default2">
            Direction
          </Text>
          <Select
            testId="webhook-log-filter-direction"
            value={direction}
            onChange={(next) => setDirection(next as DirectionFilter)}
            options={directionOptions}
          />
        </Box>
        <Box display="flex" flexDirection="column" gap={1}>
          <Text size={1} color="default2">
            Status
          </Text>
          <Select
            testId="webhook-log-filter-status"
            value={status}
            onChange={(next) => setStatus(next as StatusFilter)}
            options={statusOptions}
          />
        </Box>
        <Box display="flex" flexDirection="column" gap={1}>
          <Text size={1} color="default2">
            Connection
          </Text>
          <Select
            testId="webhook-log-filter-connection"
            value={connectionId}
            onChange={setConnectionId}
            options={connectionOptions}
          />
        </Box>
        <Box display="flex" alignItems="end">
          <Button
            variant="tertiary"
            onClick={() => listQuery.refetch?.()}
            data-testid="webhook-log-refresh"
          >
            Refresh
          </Button>
        </Box>
      </Box>

      {isLoading ? (
        <Box data-testid="webhook-log-loading" padding={6}>
          <Skeleton />
        </Box>
      ) : null}

      {!isLoading && rows.length === 0 ? (
        <Box padding={8} data-testid="webhook-log-empty">
          <Text>No webhook events match the current filters.</Text>
        </Box>
      ) : null}

      {!isLoading && rows.length > 0 ? (
        <Box display="flex" flexDirection="column" gap={3} data-testid="webhook-log-list">
          {rows.map((row) => {
            const expanded = row.id in expandedById;
            const payload = expandedById[row.id];

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
                data-testid={`webhook-log-row-${row.id}`}
              >
                <Box display="flex" gap={4} alignItems="center" justifyContent="space-between">
                  <Box display="flex" flexDirection="column" gap={1}>
                    <Text fontWeight="bold" size={3}>
                      {row.eventType}
                    </Text>
                    <DirectionLabel direction={row.direction} />
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
                    {row.createdAt}
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
                  <Button
                    variant="tertiary"
                    onClick={() => {
                      void togglePayload(row.id);
                    }}
                    data-testid={`webhook-log-view-payload-${row.id}`}
                  >
                    {expanded ? "Hide payload" : "View payload"}
                  </Button>
                </Box>

                {expanded ? <PayloadPanel rowId={row.id} payload={payload} /> : null}
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
};

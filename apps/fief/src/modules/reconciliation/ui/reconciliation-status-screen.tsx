/**
 * T38 — `<ReconciliationStatusScreen />`.
 *
 * Operator-facing reconciliation panel:
 *
 *   1. Banner: "schema changed; reconciliation recommended" when T25's
 *      flag is raised for this install.
 *   2. Connection picker — operator chooses which connection to inspect /
 *      operate on.
 *   3. "Run now" button — calls `reconciliation.runs.triggerOnDemand`.
 *      DISABLED while the most recent run for the selected connection is
 *      `status === "running"` so the operator does not hammer the lock.
 *   4. Run list — last N runs for the selected connection (start/end/
 *      status/summary counts).
 *
 * Already-running collapsing
 * --------------------------
 *   The runner returns `already_running` when a concurrent runner holds the
 *   per-connection lock. The first such response triggers an info toast.
 *   Subsequent identical responses (same `activeRunId`) do NOT spawn a new
 *   toast — without this collapsing, an impatient operator would generate
 *   one toast per click and drown the dashboard.
 *
 * Re-fetch on success
 * -------------------
 *   On a successful run we re-fetch both the runs list AND the flag.
 *   The repair use case is expected (per T25's plan) to clear the flag
 *   server-side as part of a successful run (or T38 will add an explicit
 *   ack action in a follow-up). Re-fetching means the banner disappears
 *   the moment the next render lands.
 */
import { useDashboardNotification } from "@saleor/apps-shared/use-dashboard-notification";
import { Box, Button, Chip, Skeleton, Text } from "@saleor/macaw-ui";
import { useState } from "react";

import { trpcClient } from "@/modules/trpc/trpc-client";

import {
  type ReconciliationFlagDto,
  type ReconciliationRunRowDto,
  type TriggerOnDemandResult,
} from "../trpc-router";

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

const StatusBadge = ({ status }: { status: ReconciliationRunRowDto["status"] }) => {
  if (status === "running") {
    return (
      <Chip
        data-testid="reconciliation-run-status-running"
        size="large"
        __backgroundColor="#0070F3"
        borderColor="transparent"
      >
        <Text size={1} __color="#FFF">
          Running
        </Text>
      </Chip>
    );
  }
  if (status === "failed") {
    return (
      <Chip
        data-testid="reconciliation-run-status-failed"
        size="large"
        __backgroundColor="#CC4B00"
        borderColor="transparent"
      >
        <Text size={1} __color="#FFF">
          Failed
        </Text>
      </Chip>
    );
  }

  return (
    <Chip data-testid="reconciliation-run-status-ok" size="large">
      <Text size={1} color="default1">
        OK
      </Text>
    </Chip>
  );
};

const ReconciliationRecommendedBanner = ({ flag }: { flag: ReconciliationFlagDto }) => (
  <Box
    padding={4}
    borderRadius={3}
    borderWidth={1}
    borderStyle="solid"
    borderColor="critical1"
    data-testid="reconciliation-recommended-banner"
  >
    <Text fontWeight="bold" size={3} color="critical1">
      Schema changed - reconciliation recommended
    </Text>
    <Box marginTop={2}>
      <Text size={2} color="default2">
        Reason: {flag.reason}
      </Text>
    </Box>
    {flag.raisedByEventId !== null ? (
      <Box marginTop={1}>
        <Text size={1} color="default2">
          Triggered by event {flag.raisedByEventId} at {flag.raisedAt}
        </Text>
      </Box>
    ) : (
      <Box marginTop={1}>
        <Text size={1} color="default2">
          Raised at {flag.raisedAt}
        </Text>
      </Box>
    )}
  </Box>
);

const RunRow = ({ row }: { row: ReconciliationRunRowDto }) => (
  <Box
    padding={4}
    borderWidth={1}
    borderStyle="solid"
    borderColor="default1"
    borderRadius={3}
    display="flex"
    flexDirection="column"
    gap={2}
    data-testid={`reconciliation-run-row-${row.id}`}
  >
    <Box display="flex" justifyContent="space-between" alignItems="center" gap={4}>
      <Box display="flex" flexDirection="column" gap={1}>
        <Text fontWeight="bold" size={2}>
          Started {row.startedAt}
        </Text>
        <Text size={1} color="default2">
          {row.completedAt === null ? "Still running..." : `Completed ${row.completedAt}`}
        </Text>
      </Box>
      <StatusBadge status={row.status} />
    </Box>
    <Box display="flex" gap={4}>
      <Text size={1} color="default2">
        Total: {row.summary.total}
      </Text>
      <Text size={1} color="default2">
        Repaired: {row.summary.repaired}
      </Text>
      <Text size={1} color="default2">
        Skipped: {row.summary.skipped}
      </Text>
      <Text size={1} color="default2">
        Failed: {row.summary.failed}
      </Text>
    </Box>
    {row.runError !== undefined ? (
      <Box marginTop={1}>
        <Text size={1} color="critical1">
          Error: {row.runError}
        </Text>
      </Box>
    ) : null}
  </Box>
);

export const ReconciliationStatusScreen = () => {
  const { notifySuccess, notifyError, notifyInfo } = useDashboardNotification();
  const connectionsQuery = trpcClient.connections.list.useQuery();
  const flagQuery = trpcClient.reconciliation.flags.getForInstall.useQuery();

  const connections = (connectionsQuery.data ?? []).filter((c) => c.softDeletedAt === null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");

  /*
   * Default-select the first non-deleted connection so the screen has
   * something to render without forcing the operator to pick first.
   */
  const effectiveConnectionId =
    selectedConnectionId.length > 0 ? selectedConnectionId : connections[0]?.id ?? "";

  const runsQuery = trpcClient.reconciliation.runs.listForConnection.useQuery(
    { connectionId: effectiveConnectionId },
    { enabled: effectiveConnectionId.length > 0 },
  );

  /*
   * Track the last-shown "already running" toast so repeated clicks against
   * the same active run don't duplicate the notification.
   */
  const [lastAlreadyRunningId, setLastAlreadyRunningId] = useState<string | null>(null);

  const triggerMutation = trpcClient.reconciliation.runs.triggerOnDemand.useMutation({
    onSuccess(data: TriggerOnDemandResult) {
      switch (data.outcome) {
        case "ok":
          notifySuccess("Reconciliation run started", `Run ${data.runId} - ${data.finalStatus}`);
          runsQuery.refetch?.();
          flagQuery.refetch?.();

          return;
        case "already_running":
          if (lastAlreadyRunningId !== data.activeRunId) {
            notifyInfo?.(
              "Already running",
              `A reconciliation run is already in flight (${data.activeRunId}).`,
            );
            setLastAlreadyRunningId(data.activeRunId);
          }

          return;
        case "kill_switch_disabled":
        default:
          notifyError("Reconciliation disabled", "The Fief sync kill switch is currently on.");

          return;
      }
    },
    onError(err) {
      notifyError("Failed to start reconciliation", err.message);
    },
  });

  if (connectionsQuery.isFetching && !connectionsQuery.isFetched) {
    return (
      <Box padding={6} data-testid="reconciliation-loading">
        <Skeleton />
      </Box>
    );
  }

  if (connections.length === 0) {
    return (
      <Box
        padding={10}
        display="flex"
        flexDirection="column"
        gap={4}
        alignItems="center"
        data-testid="reconciliation-no-connections"
      >
        <Text>No active connections to reconcile.</Text>
        <Text size={2} color="default2">
          Add a connection on the Connections tab to enable reconciliation.
        </Text>
      </Box>
    );
  }

  const runs = runsQuery.data ?? [];
  const latestRun = runs[0];
  const isLatestRunning = latestRun?.status === "running";

  const connectionOptions = connections.map((c) => ({ value: c.id, label: c.name }));
  const flag = flagQuery.data ?? null;

  return (
    <Box display="flex" flexDirection="column" gap={6} data-testid="reconciliation-status-screen">
      {flag !== null ? <ReconciliationRecommendedBanner flag={flag} /> : null}

      <Box display="flex" flexDirection="column" gap={3}>
        <Text size={5} fontWeight="bold">
          Reconciliation
        </Text>
        <Text size={2} color="default2">
          Trigger reconciliation on demand for a single connection, or browse the recent run history
          recorded by the scheduled cron.
        </Text>
      </Box>

      <Box display="flex" gap={4} alignItems="end">
        <Box display="flex" flexDirection="column" gap={1} flexGrow="1">
          <Text size={1} color="default2">
            Connection
          </Text>
          <Select
            id="reconciliation-connection-select"
            testId="reconciliation-connection-select"
            value={effectiveConnectionId}
            onChange={setSelectedConnectionId}
            options={connectionOptions}
          />
        </Box>
        <Button
          onClick={() => {
            if (effectiveConnectionId.length === 0) return;
            triggerMutation.mutate({ connectionId: effectiveConnectionId });
          }}
          disabled={
            triggerMutation.isLoading || isLatestRunning || effectiveConnectionId.length === 0
          }
          data-testid="reconciliation-run-now-button"
        >
          {triggerMutation.isLoading ? "Starting..." : isLatestRunning ? "Running..." : "Run now"}
        </Button>
      </Box>

      <Box display="flex" flexDirection="column" gap={3}>
        <Text size={4} fontWeight="bold">
          Recent runs
        </Text>
        {runsQuery.isFetching && !runsQuery.isFetched ? (
          <Box data-testid="reconciliation-runs-loading" padding={4}>
            <Skeleton />
          </Box>
        ) : runs.length === 0 ? (
          <Box
            padding={6}
            borderWidth={1}
            borderStyle="solid"
            borderColor="default1"
            borderRadius={3}
            data-testid="reconciliation-runs-empty"
          >
            <Text size={2} color="default2">
              No runs yet for this connection.
            </Text>
          </Box>
        ) : (
          <Box display="flex" flexDirection="column" gap={3}>
            {runs.map((row) => (
              <RunRow key={row.id} row={row} />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
};

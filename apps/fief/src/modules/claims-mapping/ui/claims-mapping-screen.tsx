/**
 * T36 - `<ClaimsMappingScreen />`.
 *
 * Per-connection editor for the claim-mapping table consumed by T14's
 * projector. Each row carries:
 *
 *   - `fiefClaim`           — claim name in Fief's ID-token / userinfo payload
 *   - `saleorMetadataKey`   — Saleor metadata key the value is projected into
 *   - `visibility`          — `"private"` (default) writes to `privateMetadata`
 *                              (server-only); `"public"` writes to `metadata`
 *                              (storefront-visible). Switching to `"public"`
 *                              shows a PII warning per T17 / PRD §F3.5.
 *   - `reverseSyncEnabled`  — opts the row in to Saleor -> Fief reverse-sync
 *                              (T28). Defaults to `false` so the
 *                              Fief-as-source-of-truth direction is preserved
 *                              unless the operator explicitly enables it.
 *
 * Read source: `connections.list` (T34) — the redacted shape includes
 * `claimMapping`. Write surface: `connections.update` with a full mapping
 * array on `patch.claimMapping`. The connection picker selects which
 * connection's mapping is being edited.
 */
import { useDashboardNotification } from "@saleor/apps-shared/use-dashboard-notification";
import { Box, Button, Skeleton, Text, TrashBinIcon } from "@saleor/macaw-ui";
import { useEffect, useState } from "react";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { type RedactedProviderConnection } from "../../provider-connections/trpc-router";

interface ClaimRow {
  fiefClaim: string;
  saleorMetadataKey: string;
  required: boolean;
  visibility: "public" | "private";
  reverseSyncEnabled: boolean;
}

const emptyRow = (): ClaimRow => ({
  fiefClaim: "",
  saleorMetadataKey: "",
  required: false,
  visibility: "private",
  reverseSyncEnabled: false,
});

const TextInput = ({
  id,
  value,
  onChange,
  testId,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  testId?: string;
  placeholder?: string;
}) => (
  <Box
    as="input"
    id={id}
    data-testid={testId}
    type="text"
    value={value}
    placeholder={placeholder}
    onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
    padding={3}
    borderRadius={3}
    borderWidth={1}
    borderStyle="solid"
    borderColor="default1"
  />
);

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

const ClaimRowEditor = ({
  index,
  row,
  onChange,
  onRemove,
}: {
  index: number;
  row: ClaimRow;
  onChange: (next: ClaimRow) => void;
  onRemove: () => void;
}) => {
  const isPublic = row.visibility === "public";

  return (
    <Box
      padding={4}
      borderWidth={1}
      borderStyle="solid"
      borderColor="default1"
      borderRadius={3}
      display="flex"
      flexDirection="column"
      gap={3}
      data-testid={`claim-row-${index}`}
    >
      <Box display="grid" gap={3} __gridTemplateColumns="1fr 1fr auto" alignItems="end">
        <Box display="flex" flexDirection="column" gap={1}>
          <Text size={1} color="default2">
            Fief claim
          </Text>
          <TextInput
            id={`claim-row-fief-claim-${index}`}
            testId={`claim-row-fief-claim-${index}`}
            value={row.fiefClaim}
            onChange={(next) => onChange({ ...row, fiefClaim: next })}
            placeholder="given_name"
          />
        </Box>
        <Box display="flex" flexDirection="column" gap={1}>
          <Text size={1} color="default2">
            Saleor metadata key
          </Text>
          <TextInput
            id={`claim-row-saleor-key-${index}`}
            testId={`claim-row-saleor-key-${index}`}
            value={row.saleorMetadataKey}
            onChange={(next) => onChange({ ...row, saleorMetadataKey: next })}
            placeholder="first_name"
          />
        </Box>
        <Button
          variant="secondary"
          icon={<TrashBinIcon />}
          onClick={onRemove}
          data-testid={`claim-row-remove-${index}`}
        />
      </Box>

      <Box display="flex" gap={6} alignItems="center" flexWrap="wrap">
        <Box display="flex" flexDirection="column" gap={1}>
          <Text size={1} color="default2">
            Visibility
          </Text>
          <Box display="flex" gap={4}>
            <Box as="label" display="flex" alignItems="center" gap={2}>
              <Box
                as="input"
                type="radio"
                name={`claim-row-visibility-${index}`}
                checked={row.visibility === "private"}
                onChange={() => onChange({ ...row, visibility: "private" })}
                data-testid={`claim-row-visibility-private-${index}`}
              />
              <Text size={2}>Private (server-only)</Text>
            </Box>
            <Box as="label" display="flex" alignItems="center" gap={2}>
              <Box
                as="input"
                type="radio"
                name={`claim-row-visibility-${index}`}
                checked={row.visibility === "public"}
                onChange={() => onChange({ ...row, visibility: "public" })}
                data-testid={`claim-row-visibility-public-${index}`}
              />
              <Text size={2}>Public (storefront-visible)</Text>
            </Box>
          </Box>
        </Box>

        <Box as="label" display="flex" alignItems="center" gap={2}>
          <Box
            as="input"
            type="checkbox"
            checked={row.reverseSyncEnabled}
            onChange={() => onChange({ ...row, reverseSyncEnabled: !row.reverseSyncEnabled })}
            data-testid={`claim-row-reverse-sync-${index}`}
          />
          <Text size={2}>Reverse sync (Saleor -&gt; Fief)</Text>
        </Box>
      </Box>

      {isPublic ? (
        <Box
          padding={3}
          borderRadius={3}
          borderWidth={1}
          borderStyle="solid"
          borderColor="critical1"
          data-testid={`claim-row-pii-warning-${index}`}
        >
          <Text size={2} color="critical1" fontWeight="medium">
            PII warning
          </Text>
          <Text size={2} color="critical1">
            Public visibility writes the claim value to Saleor metadata, which is readable by
            unauthenticated storefront API callers. Only use public for non-sensitive fields.
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};

export const ClaimsMappingScreen = () => {
  const { notifySuccess, notifyError } = useDashboardNotification();
  const connectionsQuery = trpcClient.connections.list.useQuery();

  const updateMutation = trpcClient.connections.update.useMutation({
    onSuccess() {
      notifySuccess("Claim mapping saved");
      connectionsQuery.refetch?.();
    },
    onError(err) {
      notifyError("Failed to save claim mapping", err.message);
    },
  });

  const connections = (connectionsQuery.data ?? []).filter((c) => c.softDeletedAt === null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  /*
   * Auto-select first connection on first arrival.
   */
  useEffect(() => {
    if (selectedConnectionId !== "") return;
    if (connections.length === 0) return;

    setSelectedConnectionId(connections[0].id);
  }, [connections, selectedConnectionId]);

  /*
   * Hydrate rows from the selected connection's claim mapping. Re-hydrates
   * when the operator switches connections; refetch background updates
   * to the same selected connection do NOT clobber in-flight edits.
   */
  useEffect(() => {
    if (selectedConnectionId === "") return;
    if (hydratedFor === selectedConnectionId) return;

    const target: RedactedProviderConnection | undefined = connections.find(
      (c) => c.id === selectedConnectionId,
    );

    if (target === undefined) return;

    setRows(
      target.claimMapping.map((entry) => ({
        fiefClaim: entry.fiefClaim,
        saleorMetadataKey: entry.saleorMetadataKey,
        required: entry.required ?? false,
        visibility: entry.visibility,
        reverseSyncEnabled: entry.reverseSyncEnabled,
      })),
    );
    setHydratedFor(selectedConnectionId);
  }, [connections, selectedConnectionId, hydratedFor]);

  if (connectionsQuery.isFetching && !connectionsQuery.isFetched) {
    return (
      <Box padding={6} data-testid="claims-mapping-loading">
        <Skeleton />
      </Box>
    );
  }

  if (connections.length === 0) {
    return (
      <Box padding={10} display="flex" justifyContent="center">
        <Text data-testid="claims-mapping-empty">
          Configure a Fief connection first to define claim mappings.
        </Text>
      </Box>
    );
  }

  const onSwitchConnection = (next: string) => {
    setSelectedConnectionId(next);
    setHydratedFor(null);
  };

  const onAddRow = () => {
    setRows((prev) => [...prev, emptyRow()]);
  };

  const onRemoveRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const onChangeRow = (index: number, next: ClaimRow) => {
    setRows((prev) => prev.map((r, i) => (i === index ? next : r)));
  };

  const onSave = () => {
    if (selectedConnectionId === "") return;

    updateMutation.mutate({
      id: selectedConnectionId,
      patch: {
        claimMapping: rows.map((row) => ({
          fiefClaim: row.fiefClaim,
          saleorMetadataKey: row.saleorMetadataKey,
          required: row.required,
          visibility: row.visibility,
          reverseSyncEnabled: row.reverseSyncEnabled,
        })),
      },
    });
  };

  return (
    <Box display="flex" flexDirection="column" gap={8} data-testid="claims-mapping-screen">
      <Box display="flex" flexDirection="column" gap={3}>
        <Text size={5} fontWeight="bold">
          Connection
        </Text>
        <Select
          id="claims-mapping-connection-select"
          testId="claims-mapping-connection-select"
          value={selectedConnectionId}
          onChange={onSwitchConnection}
          options={connections.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Box>

      <Box display="flex" flexDirection="column" gap={3}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Text size={5} fontWeight="bold">
            Claim mapping
          </Text>
          <Button variant="secondary" onClick={onAddRow} data-testid="claims-mapping-add-row">
            Add row
          </Button>
        </Box>
        <Text size={2} color="default2">
          Defaults: visibility = private, reverse-sync disabled. Only opt in to public visibility
          for non-sensitive fields, and to reverse-sync when Saleor should be a source of truth for
          the claim.
        </Text>

        {rows.length === 0 ? (
          <Text size={2} color="default2" data-testid="claims-mapping-rows-empty">
            No claim mappings yet. Click &quot;Add row&quot; to start.
          </Text>
        ) : (
          <Box display="flex" flexDirection="column" gap={3}>
            {rows.map((row, index) => (
              <ClaimRowEditor
                key={index}
                index={index}
                row={row}
                onChange={(next) => onChangeRow(index, next)}
                onRemove={() => onRemoveRow(index)}
              />
            ))}
          </Box>
        )}
      </Box>

      <Box display="flex" justifyContent="flex-end">
        <Button
          onClick={onSave}
          disabled={updateMutation.isLoading || selectedConnectionId === ""}
          data-testid="claims-mapping-save"
        >
          {updateMutation.isLoading ? "Saving..." : "Save claim mapping"}
        </Button>
      </Box>
    </Box>
  );
};

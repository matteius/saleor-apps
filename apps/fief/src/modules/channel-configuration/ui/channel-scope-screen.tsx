/**
 * T36 - `<ChannelScopeScreen />`.
 *
 * Picks the install-wide default Fief connection plus per-channel overrides.
 * Mirrors the Avatax channel-config pattern (`apps/avatax/src/modules/channel-
 * configuration/ui/`) but flattens its row-per-channel layout into a single
 * "default + overrides" form because T9 / T34 store the configuration as one
 * document per saleorApiUrl (not one row per channel).
 *
 * Two read sources via tRPC (T34):
 *   - `channelConfig.get`     — current config (or null when nothing has been
 *     written yet).
 *   - `connections.list`      — populates the connection picker. Uses the
 *     redacted shape from T34; we never see ciphertext.
 *
 * Write surface:
 *   - `channelConfig.upsert`  — full-replace per T9's repo contract.
 *
 * Confirm-on-disable
 * ------------------
 *
 * Marking a per-channel override `connectionId` to the literal `"disabled"`
 * sentinel pops a Modal. On cancel the previous selection is restored and
 * no upsert call is made; on confirm the row is committed and the operator
 * still has to click Save to persist the document.
 */
import { useDashboardNotification } from "@saleor/apps-shared/use-dashboard-notification";
import { Box, Button, Modal, Skeleton, Text, TrashBinIcon } from "@saleor/macaw-ui";
import { useEffect, useState } from "react";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { DISABLED_CHANNEL } from "../channel-configuration";

interface OverrideRow {
  channelSlug: string;
  connectionId: string;
}

const NotConfiguredOption = "" as const;

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

const DisableConfirmModal = ({
  open,
  channelSlug,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  channelSlug: string;
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  <Modal open={open} onChange={(next) => (next ? undefined : onCancel())}>
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
        data-testid="channel-scope-disable-confirm"
      >
        <Text size={6} fontWeight="bold">
          Disable channel sync
        </Text>
        <Text>
          Marking channel
          {channelSlug.length > 0 ? ` "${channelSlug}"` : ""} as disabled stops Fief from syncing
          users for this channel. Webhook events that arrive for this channel will be ignored. Are
          you sure?
        </Text>
        <Box display="flex" justifyContent="flex-end" gap={3}>
          <Button variant="secondary" onClick={onCancel} data-testid="channel-scope-disable-cancel">
            Cancel
          </Button>
          <Button
            variant="error"
            onClick={onConfirm}
            data-testid="channel-scope-disable-confirm-button"
          >
            Disable channel
          </Button>
        </Box>
      </Box>
    </Modal.Content>
  </Modal>
);

export const ChannelScopeScreen = () => {
  const { notifySuccess, notifyError } = useDashboardNotification();
  const configQuery = trpcClient.channelConfig.get.useQuery();
  const connectionsQuery = trpcClient.connections.list.useQuery();

  const upsertMutation = trpcClient.channelConfig.upsert.useMutation({
    onSuccess() {
      notifySuccess("Channel scope saved");
      configQuery.refetch?.();
    },
    onError(err) {
      notifyError("Failed to save channel scope", err.message);
    },
  });

  const [defaultConnectionId, setDefaultConnectionId] = useState<string>(NotConfiguredOption);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [pendingDisableIndex, setPendingDisableIndex] = useState<number | null>(null);

  /*
   * Hydrate from the persisted config. We deliberately seed once when the
   * query first delivers a value so subsequent edits do not get clobbered
   * by background re-fetches.
   */
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated || configQuery.isFetching) return;

    const data = configQuery.data;

    if (data === null || data === undefined) {
      setHydrated(true);

      return;
    }

    setDefaultConnectionId((data.defaultConnectionId as unknown as string) ?? NotConfiguredOption);
    setOverrides(
      (data.overrides ?? []).map((o) => ({
        channelSlug: o.channelSlug as unknown as string,
        connectionId: o.connectionId as unknown as string,
      })),
    );
    setHydrated(true);
  }, [configQuery.data, configQuery.isFetching, hydrated]);

  const isLoading =
    (configQuery.isFetching && !configQuery.isFetched) ||
    (connectionsQuery.isFetching && !connectionsQuery.isFetched);

  if (isLoading) {
    return (
      <Box padding={6} data-testid="channel-scope-loading">
        <Skeleton />
      </Box>
    );
  }

  const connections = (connectionsQuery.data ?? []).filter((c) => c.softDeletedAt === null);

  const connectionOptions = [
    { value: NotConfiguredOption, label: "Not configured" },
    ...connections.map((c) => ({ value: c.id, label: c.name })),
  ];

  const overrideConnectionOptions = [
    ...connections.map((c) => ({ value: c.id, label: c.name })),
    { value: DISABLED_CHANNEL, label: "Disabled (no sync)" },
  ];

  const onAddOverride = () => {
    setOverrides((prev) => [
      ...prev,
      { channelSlug: "", connectionId: connections[0]?.id ?? NotConfiguredOption },
    ]);
  };

  const onRemoveOverride = (index: number) => {
    setOverrides((prev) => prev.filter((_, i) => i !== index));
  };

  const onChangeOverrideSlug = (index: number, slug: string) => {
    setOverrides((prev) =>
      prev.map((row, i) => (i === index ? { ...row, channelSlug: slug } : row)),
    );
  };

  const onChangeOverrideConnection = (index: number, connectionId: string) => {
    if (connectionId === DISABLED_CHANNEL) {
      /* Hold the disabled change pending operator confirmation. */
      setPendingDisableIndex(index);

      return;
    }
    setOverrides((prev) => prev.map((row, i) => (i === index ? { ...row, connectionId } : row)));
  };

  const onConfirmDisable = () => {
    if (pendingDisableIndex === null) return;
    const idx = pendingDisableIndex;

    setOverrides((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, connectionId: DISABLED_CHANNEL } : row)),
    );
    setPendingDisableIndex(null);
  };

  const onCancelDisable = () => {
    setPendingDisableIndex(null);
  };

  const onSave = () => {
    upsertMutation.mutate({
      defaultConnectionId: defaultConnectionId === NotConfiguredOption ? null : defaultConnectionId,
      overrides: overrides
        .filter((row) => row.channelSlug.length > 0 && row.connectionId.length > 0)
        .map((row) => ({
          channelSlug: row.channelSlug,
          connectionId: row.connectionId,
        })),
    });
  };

  return (
    <Box display="flex" flexDirection="column" gap={8} data-testid="channel-scope-screen">
      <Box display="flex" flexDirection="column" gap={3}>
        <Text size={5} fontWeight="bold">
          Default Fief connection
        </Text>
        <Text size={2} color="default2">
          Used for every Saleor channel that does not have an override below.
        </Text>
        <Select
          id="channel-scope-default-select"
          testId="channel-scope-default-select"
          value={defaultConnectionId}
          onChange={setDefaultConnectionId}
          options={connectionOptions}
        />
      </Box>

      <Box display="flex" flexDirection="column" gap={3}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Text size={5} fontWeight="bold">
            Channel overrides
          </Text>
          <Button
            variant="secondary"
            onClick={onAddOverride}
            data-testid="channel-scope-add-override"
          >
            Add override
          </Button>
        </Box>
        <Text size={2} color="default2">
          Override the default connection for specific Saleor channels, or mark a channel as
          disabled to opt it out of all Fief sync.
        </Text>

        {overrides.length === 0 ? (
          <Text size={2} color="default2" data-testid="channel-scope-overrides-empty">
            No overrides yet. The default applies to every channel.
          </Text>
        ) : (
          <Box display="flex" flexDirection="column" gap={3}>
            {overrides.map((row, index) => (
              <Box
                key={index}
                display="grid"
                gap={3}
                padding={4}
                borderWidth={1}
                borderStyle="solid"
                borderColor="default1"
                borderRadius={3}
                data-testid={`channel-scope-override-row-${index}`}
                __gridTemplateColumns="1fr 1fr auto"
                alignItems="end"
              >
                <Box display="flex" flexDirection="column" gap={1}>
                  <Text size={1} color="default2">
                    Channel slug
                  </Text>
                  <TextInput
                    id={`channel-scope-override-slug-${index}`}
                    testId={`channel-scope-override-slug-${index}`}
                    value={row.channelSlug}
                    onChange={(next) => onChangeOverrideSlug(index, next)}
                    placeholder="us-store"
                  />
                </Box>
                <Box display="flex" flexDirection="column" gap={1}>
                  <Text size={1} color="default2">
                    Connection
                  </Text>
                  <Select
                    id={`channel-scope-override-connection-${index}`}
                    testId={`channel-scope-override-connection-${index}`}
                    value={row.connectionId}
                    onChange={(next) => onChangeOverrideConnection(index, next)}
                    options={overrideConnectionOptions}
                  />
                </Box>
                <Button
                  variant="secondary"
                  icon={<TrashBinIcon />}
                  onClick={() => onRemoveOverride(index)}
                  data-testid={`channel-scope-override-remove-${index}`}
                />
              </Box>
            ))}
          </Box>
        )}
      </Box>

      <Box display="flex" justifyContent="flex-end">
        <Button
          onClick={onSave}
          disabled={upsertMutation.isLoading}
          data-testid="channel-scope-save"
        >
          {upsertMutation.isLoading ? "Saving..." : "Save channel scope"}
        </Button>
      </Box>

      <DisableConfirmModal
        open={pendingDisableIndex !== null}
        channelSlug={
          pendingDisableIndex !== null ? overrides[pendingDisableIndex]?.channelSlug ?? "" : ""
        }
        onCancel={onCancelDisable}
        onConfirm={onConfirmDisable}
      />
    </Box>
  );
};

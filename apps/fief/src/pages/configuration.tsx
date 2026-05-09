/**
 * T35 / T36 / T37 — Top-level configuration dashboard for the Fief Saleor App.
 *
 * The page is rendered inside the Saleor dashboard iframe via the route
 * declared in the app manifest (`/configuration`).
 *
 * Top-level tabs:
 *
 *   - "connections"     — `<ConnectionListScreen />` + create/edit/rotate
 *   - "channel-scope"   — `<ChannelScopeScreen />`           (T36)
 *   - "claims"          — `<ClaimsMappingScreen />`          (T36)
 *   - "webhook-health"  — `<WebhookHealthScreen />` + `<DlqScreen />` (T37)
 *
 * Within the connections tab the page owns a state machine that switches
 * between list/create/edit/rotate modes. State transitions are kept in
 * component-local state (no router pushes) so the iframe URL stays stable
 * while the operator works through the flow.
 */
import { Box, Button, Text } from "@saleor/macaw-ui";
import { useState } from "react";

import { ChannelScopeScreen } from "@/modules/channel-configuration/ui/channel-scope-screen";
import { ClaimsMappingScreen } from "@/modules/claims-mapping/ui/claims-mapping-screen";
import { DlqScreen } from "@/modules/dlq/ui/dlq-screen";
import { type RedactedProviderConnection } from "@/modules/provider-connections/trpc-router";
import { ConnectionFormScreen } from "@/modules/provider-connections/ui/connection-form-screen";
import { ConnectionListScreen } from "@/modules/provider-connections/ui/connection-list-screen";
import { RotateSecretFlow } from "@/modules/provider-connections/ui/rotate-secret-flow";
import { trpcClient } from "@/modules/trpc/trpc-client";
import { WebhookHealthScreen } from "@/modules/webhook-log/ui/webhook-health-screen";

type ScreenMode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; connectionId: string }
  | { kind: "rotate"; connectionId: string };

type Tab = "connections" | "channel-scope" | "claims" | "webhook-health";

const TabButton = ({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) => (
  <Button variant={active ? "primary" : "tertiary"} onClick={onClick} data-testid={testId}>
    {children}
  </Button>
);

const Header = () => (
  <Box marginBottom={8} paddingBottom={6}>
    <Text as="h1" marginBottom={4} size={10} fontWeight="bold">
      Fief connections
    </Text>
    <Text>
      Configure connections from this Saleor install to one or more Fief tenants. Each connection
      issues a dedicated OIDC client + webhook subscriber with an encrypted secret store.
    </Text>
  </Box>
);

const ConfigurationPage = () => {
  const [tab, setTab] = useState<Tab>("connections");
  const [mode, setMode] = useState<ScreenMode>({ kind: "list" });
  const listQuery = trpcClient.connections.list.useQuery();

  const findConnection = (id: string): RedactedProviderConnection | undefined =>
    (listQuery.data ?? []).find((c) => c.id === id);

  const onSaved = () => {
    listQuery.refetch?.();
    setMode({ kind: "list" });
  };

  const onCancel = () => setMode({ kind: "list" });

  return (
    <Box>
      <Header />

      <Box display="flex" gap={3} marginBottom={6} data-testid="configuration-tabs">
        <TabButton
          active={tab === "connections"}
          onClick={() => setTab("connections")}
          testId="configuration-tab-connections"
        >
          Connections
        </TabButton>
        <TabButton
          active={tab === "channel-scope"}
          onClick={() => setTab("channel-scope")}
          testId="configuration-tab-channel-scope"
        >
          Channel scope
        </TabButton>
        <TabButton
          active={tab === "claims"}
          onClick={() => setTab("claims")}
          testId="configuration-tab-claims"
        >
          Claims mapping
        </TabButton>
        <TabButton
          active={tab === "webhook-health"}
          onClick={() => setTab("webhook-health")}
          testId="configuration-tab-webhook-health"
        >
          Webhook health
        </TabButton>
      </Box>

      {tab === "connections" ? (
        <Box>
          {mode.kind === "list" ? (
            <ConnectionListScreen
              onCreateNew={() => setMode({ kind: "create" })}
              onEdit={(connectionId) => setMode({ kind: "edit", connectionId })}
              onRotate={(connectionId) => setMode({ kind: "rotate", connectionId })}
            />
          ) : null}

          {mode.kind === "create" ? (
            <ConnectionFormScreen mode="create" onCancel={onCancel} onSaved={onSaved} />
          ) : null}

          {mode.kind === "edit" ? (
            <Box display="flex" flexDirection="column" gap={4}>
              <Box display="flex" justifyContent="flex-start">
                <Button variant="tertiary" onClick={onCancel}>
                  Back to list
                </Button>
              </Box>
              <ConnectionFormScreen
                mode="edit"
                initialConnection={findConnection(mode.connectionId)}
                onCancel={onCancel}
                onSaved={onSaved}
              />
            </Box>
          ) : null}

          {mode.kind === "rotate" ? (
            <Box display="flex" flexDirection="column" gap={4}>
              <Box display="flex" justifyContent="flex-start">
                <Button variant="tertiary" onClick={onCancel}>
                  Back to list
                </Button>
              </Box>
              {findConnection(mode.connectionId) ? (
                <RotateSecretFlow
                  connection={findConnection(mode.connectionId) as RedactedProviderConnection}
                  onClose={() => {
                    listQuery.refetch?.();
                    setMode({ kind: "list" });
                  }}
                />
              ) : (
                <Text>Connection not found.</Text>
              )}
            </Box>
          ) : null}
        </Box>
      ) : null}

      {tab === "channel-scope" ? <ChannelScopeScreen /> : null}

      {tab === "claims" ? <ClaimsMappingScreen /> : null}

      {tab === "webhook-health" ? (
        <Box display="flex" flexDirection="column" gap={10}>
          <WebhookHealthScreen />
          <DlqScreen />
        </Box>
      ) : null}
    </Box>
  );
};

export default ConfigurationPage;

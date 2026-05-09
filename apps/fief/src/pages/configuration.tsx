/**
 * T35 — Top-level configuration dashboard for the Fief Saleor App.
 *
 * The page is rendered inside the Saleor dashboard iframe via the route
 * declared in the app manifest (`/configuration`). It owns the state
 * machine that switches between the three Macaw screens:
 *
 *   - "list"   — `<ConnectionListScreen />`
 *   - "create" — `<ConnectionFormScreen mode="create" />`
 *   - "edit"   — `<ConnectionFormScreen mode="edit" initialConnection={...} />`
 *   - "rotate" — `<RotateSecretFlow connection={...} />`
 *
 * State transitions are kept in component-local state (no router pushes) so
 * the iframe URL stays stable while the operator works through the flow.
 */
import { Box, Button, Text } from "@saleor/macaw-ui";
import { useState } from "react";

import { type RedactedProviderConnection } from "@/modules/provider-connections/trpc-router";
import { ConnectionFormScreen } from "@/modules/provider-connections/ui/connection-form-screen";
import { ConnectionListScreen } from "@/modules/provider-connections/ui/connection-list-screen";
import { RotateSecretFlow } from "@/modules/provider-connections/ui/rotate-secret-flow";
import { trpcClient } from "@/modules/trpc/trpc-client";

type ScreenMode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; connectionId: string }
  | { kind: "rotate"; connectionId: string };

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
  );
};

export default ConfigurationPage;

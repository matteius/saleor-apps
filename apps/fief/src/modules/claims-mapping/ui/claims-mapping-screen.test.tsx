/**
 * T36 - <ClaimsMappingScreen /> behavioral tests.
 *
 * Confirms:
 *   - operator picks a connection -> existing claim mappings render in rows
 *   - "Add row" creates a new row with default visibility="private",
 *     reverseSyncEnabled=false, and clicking Save calls
 *     `connections.update` with the full mapping array
 *   - flipping a row visibility radio to "public" surfaces a PII warning
 *   - flipping reverseSyncEnabled toggle on a row gates only that row's flag
 *
 * tRPC client is mocked at the module-singleton seam used by every other UI
 * test in this app.
 */
import { ThemeProvider } from "@saleor/macaw-ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { type RedactedProviderConnection } from "../../provider-connections/trpc-router";
import { ClaimsMappingScreen } from "./claims-mapping-screen";

vi.mock("@/modules/trpc/trpc-client", () => ({
  trpcClient: {
    connections: {
      list: { useQuery: vi.fn() },
      update: { useMutation: vi.fn() },
    },
  },
}));

vi.mock("@saleor/apps-shared/use-dashboard-notification", () => ({
  useDashboardNotification: () => ({
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
  }),
}));

const baseConnection: RedactedProviderConnection = {
  id: "00000000-0000-0000-0000-000000000001",
  saleorApiUrl: "https://shop.saleor.cloud/graphql/",
  name: "Production Fief",
  fief: {
    baseUrl: "https://fief.example.com",
    tenantId: "default-tenant",
    clientId: "fief-client-id",
    webhookId: "wh-1",
  },
  branding: { allowedOrigins: ["https://shop.example.com"] },
  claimMapping: [
    {
      fiefClaim: "given_name",
      saleorMetadataKey: "first_name",
      required: false,
      visibility: "private",
      reverseSyncEnabled: false,
    },
  ],
  softDeletedAt: null,
  secrets: {
    hasClientSecret: true,
    hasPendingClientSecret: false,
    hasAdminToken: true,
    hasWebhookSecret: true,
    hasPendingWebhookSecret: false,
    hasSigningKey: true,
  },
};

const renderInTheme = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

describe("ClaimsMappingScreen", () => {
  beforeEach(() => {
    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [baseConnection],
      isFetching: false,
      isFetched: true,
      refetch: vi.fn(),
    } as never);

    vi.mocked(trpcClient.connections.update.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isLoading: false,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders existing claim mappings for the selected connection", () => {
    renderInTheme(<ClaimsMappingScreen />);

    /* The first connection is auto-selected. */
    const row = screen.getByTestId("claim-row-0");

    expect(within(row).getByDisplayValue("given_name")).toBeTruthy();
    expect(within(row).getByDisplayValue("first_name")).toBeTruthy();
  });

  it("adds a new row, defaults visibility to private, and submits the full mapping array", async () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.connections.update.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(<ClaimsMappingScreen />);

    fireEvent.click(screen.getAllByTestId("claims-mapping-add-row")[0]);

    const newRow = await screen.findByTestId("claim-row-1");

    fireEvent.change(within(newRow).getByTestId("claim-row-fief-claim-1"), {
      target: { value: "preferred_username" },
    });
    fireEvent.change(within(newRow).getByTestId("claim-row-saleor-key-1"), {
      target: { value: "username" },
    });

    /* Defaults: visibility=private, reverseSyncEnabled=false. */
    const privateRadio = within(newRow).getByTestId(
      "claim-row-visibility-private-1",
    ) as HTMLInputElement;

    expect(privateRadio.checked).toBe(true);

    const reverseToggle = within(newRow).getByTestId(
      "claim-row-reverse-sync-1",
    ) as HTMLInputElement;

    expect(reverseToggle.checked).toBe(false);

    screen.getAllByTestId("claims-mapping-save").forEach((el) => fireEvent.click(el));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));

    expect(mutate.mock.calls[0][0]).toStrictEqual({
      id: baseConnection.id,
      patch: {
        claimMapping: [
          {
            fiefClaim: "given_name",
            saleorMetadataKey: "first_name",
            required: false,
            visibility: "private",
            reverseSyncEnabled: false,
          },
          {
            fiefClaim: "preferred_username",
            saleorMetadataKey: "username",
            required: false,
            visibility: "private",
            reverseSyncEnabled: false,
          },
        ],
      },
    });
  });

  it("shows a PII warning when a row's visibility is switched to public", () => {
    renderInTheme(<ClaimsMappingScreen />);

    const row = screen.getByTestId("claim-row-0");

    /* Initially private -> no warning. */
    expect(within(row).queryByTestId("claim-row-pii-warning-0")).toBeNull();

    fireEvent.click(within(row).getByTestId("claim-row-visibility-public-0"));

    expect(within(row).getByTestId("claim-row-pii-warning-0")).toBeTruthy();
  });

  it("toggling reverse-sync on row 0 does not flip row 1", async () => {
    const localConnection: RedactedProviderConnection = {
      ...baseConnection,
      claimMapping: [
        {
          fiefClaim: "given_name",
          saleorMetadataKey: "first_name",
          required: false,
          visibility: "private",
          reverseSyncEnabled: false,
        },
        {
          fiefClaim: "family_name",
          saleorMetadataKey: "last_name",
          required: false,
          visibility: "private",
          reverseSyncEnabled: false,
        },
      ],
    };

    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [localConnection],
      isFetching: false,
      isFetched: true,
      refetch: vi.fn(),
    } as never);

    const mutate = vi.fn();

    vi.mocked(trpcClient.connections.update.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(<ClaimsMappingScreen />);

    fireEvent.click(screen.getByTestId("claim-row-reverse-sync-0"));

    screen.getAllByTestId("claims-mapping-save").forEach((el) => fireEvent.click(el));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));

    const sent = mutate.mock.calls[0][0];

    expect(sent.patch.claimMapping[0].reverseSyncEnabled).toBe(true);
    expect(sent.patch.claimMapping[1].reverseSyncEnabled).toBe(false);
  });
});

/**
 * T36 - <ChannelScopeScreen /> behavioral tests.
 *
 * Confirms:
 *   - operator picks default connection -> upsert called with that defaultConnectionId
 *   - operator adds a per-channel override -> upsert called with overrides[] preserved
 *   - marking a channel "disabled" pops a confirm Modal:
 *       - cancel  -> no upsert call
 *       - confirm -> upsert called with `connectionId: "disabled"`
 *
 * tRPC client is mocked at the module-singleton seam used by every other UI
 * test in this app (see `connection-list-screen.test.tsx` for the pattern).
 * No HTTP leaves the test process.
 */
import { ThemeProvider } from "@saleor/macaw-ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { type RedactedProviderConnection } from "../../provider-connections/trpc-router";
import { ChannelScopeScreen } from "./channel-scope-screen";

vi.mock("@/modules/trpc/trpc-client", () => ({
  trpcClient: {
    connections: {
      list: { useQuery: vi.fn() },
    },
    channelConfig: {
      get: { useQuery: vi.fn() },
      upsert: { useMutation: vi.fn() },
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
  id: "conn-prod",
  saleorApiUrl: "https://shop.saleor.cloud/graphql/",
  name: "Production Fief",
  fief: {
    baseUrl: "https://fief.example.com",
    tenantId: "default-tenant",
    clientId: "fief-client-id",
    webhookId: "wh-1",
  },
  branding: { allowedOrigins: ["https://shop.example.com"] },
  claimMapping: [],
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

const stagingConnection: RedactedProviderConnection = {
  ...baseConnection,
  id: "conn-staging",
  name: "Staging Fief",
};

const renderInTheme = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

const wireConnections = (rows: RedactedProviderConnection[]) => {
  vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
    data: rows,
    isFetching: false,
    isFetched: true,
  } as never);
};

describe("ChannelScopeScreen", () => {
  beforeEach(() => {
    wireConnections([baseConnection, stagingConnection]);

    vi.mocked(trpcClient.channelConfig.get.useQuery).mockReturnValue({
      data: null,
      isFetching: false,
      isFetched: true,
      refetch: vi.fn(),
    } as never);

    vi.mocked(trpcClient.channelConfig.upsert.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isLoading: false,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it("submits upsert with the operator-selected default connection", async () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.channelConfig.upsert.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(<ChannelScopeScreen />);

    fireEvent.change(screen.getByTestId("channel-scope-default-select"), {
      target: { value: "conn-prod" },
    });

    screen.getAllByTestId("channel-scope-save").forEach((el) => fireEvent.click(el));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledTimes(1);
    });

    expect(mutate.mock.calls[0][0]).toStrictEqual({
      defaultConnectionId: "conn-prod",
      overrides: [],
    });
  });

  it("preserves operator-added overrides on upsert", async () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.channelConfig.upsert.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(<ChannelScopeScreen />);

    fireEvent.change(screen.getByTestId("channel-scope-default-select"), {
      target: { value: "conn-prod" },
    });

    fireEvent.click(screen.getAllByTestId("channel-scope-add-override")[0]);

    const slugInputs = await screen.findAllByTestId("channel-scope-override-slug-0");
    const connSelects = screen.getAllByTestId("channel-scope-override-connection-0");

    fireEvent.change(slugInputs[0], { target: { value: "us-store" } });
    fireEvent.change(connSelects[0], { target: { value: "conn-staging" } });

    screen.getAllByTestId("channel-scope-save").forEach((el) => fireEvent.click(el));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));

    expect(mutate.mock.calls[0][0]).toStrictEqual({
      defaultConnectionId: "conn-prod",
      overrides: [{ channelSlug: "us-store", connectionId: "conn-staging" }],
    });
  });

  it("opens a confirm Modal when an override is marked 'disabled' and aborts on cancel", async () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.channelConfig.upsert.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(<ChannelScopeScreen />);

    fireEvent.click(screen.getAllByTestId("channel-scope-add-override")[0]);

    const slugInputs = await screen.findAllByTestId("channel-scope-override-slug-0");

    fireEvent.change(slugInputs[0], { target: { value: "eu-store" } });
    fireEvent.change(screen.getAllByTestId("channel-scope-override-connection-0")[0], {
      target: { value: "disabled" },
    });

    /* Modal should appear; cancelling means no upsert. */
    const modal = await screen.findByTestId("channel-scope-disable-confirm");

    expect(modal).toBeTruthy();

    fireEvent.click(within(modal).getAllByTestId("channel-scope-disable-cancel")[0]);

    await waitFor(() => {
      expect(screen.queryByTestId("channel-scope-disable-confirm")).toBeNull();
    });

    /* Selection should NOT have been committed to "disabled". */
    expect(
      (screen.getAllByTestId("channel-scope-override-connection-0")[0] as HTMLSelectElement).value,
    ).not.toBe("disabled");

    expect(mutate).not.toHaveBeenCalled();
  });

  it("commits the disabled selection when the operator confirms in the Modal", async () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.channelConfig.upsert.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(<ChannelScopeScreen />);

    fireEvent.click(screen.getAllByTestId("channel-scope-add-override")[0]);

    const slugInputs = await screen.findAllByTestId("channel-scope-override-slug-0");

    fireEvent.change(slugInputs[0], { target: { value: "eu-store" } });
    fireEvent.change(screen.getAllByTestId("channel-scope-override-connection-0")[0], {
      target: { value: "disabled" },
    });

    const modal = await screen.findByTestId("channel-scope-disable-confirm");

    fireEvent.click(within(modal).getAllByTestId("channel-scope-disable-confirm-button")[0]);

    await waitFor(() => {
      expect(screen.queryByTestId("channel-scope-disable-confirm")).toBeNull();
    });

    screen.getAllByTestId("channel-scope-save").forEach((el) => fireEvent.click(el));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));

    expect(mutate.mock.calls[0][0]).toStrictEqual({
      defaultConnectionId: null,
      overrides: [{ channelSlug: "eu-store", connectionId: "disabled" }],
    });
  });

  it("hydrates form from existing channelConfig.get response", async () => {
    vi.mocked(trpcClient.channelConfig.get.useQuery).mockReturnValue({
      data: {
        saleorApiUrl: baseConnection.saleorApiUrl,
        defaultConnectionId: "conn-staging",
        overrides: [{ channelSlug: "us-store", connectionId: "conn-prod" }],
      },
      isFetching: false,
      isFetched: true,
      refetch: vi.fn(),
    } as never);

    renderInTheme(<ChannelScopeScreen />);

    expect((screen.getByTestId("channel-scope-default-select") as HTMLSelectElement).value).toBe(
      "conn-staging",
    );
    expect((screen.getByTestId("channel-scope-override-slug-0") as HTMLInputElement).value).toBe(
      "us-store",
    );
    expect(
      (screen.getByTestId("channel-scope-override-connection-0") as HTMLSelectElement).value,
    ).toBe("conn-prod");
  });
});

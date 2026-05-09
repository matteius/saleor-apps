/**
 * T37 — `<DlqScreen />` behavioral tests.
 *
 * Confirms:
 *   - renders DLQ entries returned by the stubbed `dlq.list` tRPC client
 *   - "Replay" button is enabled when the bound connection is live
 *   - "Replay" button is disabled when the bound connection is soft-deleted
 *     (visual disabled + tooltip via title attribute)
 *   - clicking Replay calls `dlq.replay` and removes the row on success
 *   - on `connection_deleted` error, the row stays and the button stays
 *     disabled with the deleted-connection tooltip
 */
import { ThemeProvider } from "@saleor/macaw-ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RedactedProviderConnection } from "@/modules/provider-connections/trpc-router";
import { trpcClient } from "@/modules/trpc/trpc-client";

import { DlqScreen } from "./dlq-screen";

vi.mock("@/modules/trpc/trpc-client", () => ({
  trpcClient: {
    connections: {
      list: { useQuery: vi.fn() },
    },
    dlq: {
      list: { useQuery: vi.fn() },
      replay: { useMutation: vi.fn() },
    },
  },
}));

vi.mock("@saleor/apps-shared/use-dashboard-notification", () => ({
  useDashboardNotification: () => ({
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
  }),
}));

const liveConnection: RedactedProviderConnection = {
  id: "conn-live",
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

const softDeletedConnection: RedactedProviderConnection = {
  ...liveConnection,
  id: "conn-deleted",
  name: "Old Fief",
  softDeletedAt: "2024-01-01T00:00:00.000Z",
};

const liveEntry = {
  id: "dlq-live",
  connectionId: "conn-live",
  direction: "fief_to_saleor" as const,
  eventId: "evt-live",
  eventType: "user.created",
  status: "dead" as const,
  attempts: 6,
  lastError: "boom",
  movedToDlqAt: "2026-05-01T00:05:00.000Z",
};

const softDeletedEntry = {
  id: "dlq-soft-deleted",
  connectionId: "conn-deleted",
  direction: "fief_to_saleor" as const,
  eventId: "evt-soft-deleted",
  eventType: "customer.updated",
  status: "dead" as const,
  attempts: 6,
  lastError: "boom",
  movedToDlqAt: "2026-05-01T00:06:00.000Z",
};

const renderInTheme = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

const wireListQueries = (
  entries: (typeof liveEntry)[],
  connections: RedactedProviderConnection[],
) => {
  vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
    data: connections,
    isFetching: false,
    isFetched: true,
  } as never);

  vi.mocked(trpcClient.dlq.list.useQuery).mockReturnValue({
    data: { rows: entries },
    isFetching: false,
    isFetched: true,
    refetch: vi.fn(),
  } as never);
};

describe("DlqScreen", () => {
  beforeEach(() => {
    vi.mocked(trpcClient.dlq.replay.useMutation).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isLoading: false,
      reset: vi.fn(),
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a row per DLQ entry returned by the stub", () => {
    wireListQueries([liveEntry, softDeletedEntry], [liveConnection, softDeletedConnection]);

    renderInTheme(<DlqScreen />);

    expect(screen.getByTestId(`dlq-row-${liveEntry.id}`)).toBeTruthy();
    expect(screen.getByTestId(`dlq-row-${softDeletedEntry.id}`)).toBeTruthy();
  });

  it("enables the Replay button for entries bound to a live connection", () => {
    wireListQueries([liveEntry], [liveConnection]);

    renderInTheme(<DlqScreen />);

    const button = screen.getAllByTestId(`dlq-replay-${liveEntry.id}`)[0] as HTMLButtonElement;

    expect(button.disabled).toBe(false);
  });

  it("disables the Replay button for entries bound to a soft-deleted connection", () => {
    wireListQueries([softDeletedEntry], [liveConnection, softDeletedConnection]);

    renderInTheme(<DlqScreen />);

    const button = screen.getAllByTestId(
      `dlq-replay-${softDeletedEntry.id}`,
    )[0] as HTMLButtonElement;

    expect(button.disabled).toBe(true);

    /* Tooltip surfaced via the title attribute. */
    const wrapper = screen.getByTestId(`dlq-replay-tooltip-${softDeletedEntry.id}`);

    expect(wrapper.getAttribute("title") ?? "").toContain("Connection deleted");
  });

  it("calls dlq.replay.mutate on click for live connections", async () => {
    wireListQueries([liveEntry], [liveConnection]);

    const mutate = vi.fn();

    vi.mocked(trpcClient.dlq.replay.useMutation).mockReturnValue({
      mutate,
      mutateAsync: vi.fn(),
      isLoading: false,
      reset: vi.fn(),
    } as never);

    renderInTheme(<DlqScreen />);

    fireEvent.click(screen.getAllByTestId(`dlq-replay-${liveEntry.id}`)[0]);

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({ dlqEntryId: liveEntry.id });
    });
  });

  it("removes the row on successful replay (refetch list)", async () => {
    const refetch = vi.fn();
    let onSuccessCb: ((data: unknown, variables: unknown) => void) | undefined;

    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [liveConnection],
      isFetching: false,
      isFetched: true,
    } as never);

    vi.mocked(trpcClient.dlq.list.useQuery).mockReturnValue({
      data: { rows: [liveEntry] },
      isFetching: false,
      isFetched: true,
      refetch,
    } as never);

    vi.mocked(trpcClient.dlq.replay.useMutation).mockImplementation(((opts: {
      onSuccess?: (data: unknown, variables: unknown) => void;
    }) => {
      onSuccessCb = opts?.onSuccess;

      return {
        mutate: (vars: unknown) => {
          /* Simulate immediate success for the test. */
          onSuccessCb?.({ replayed: true, direction: "fief_to_saleor" }, vars);
        },
        mutateAsync: vi.fn(),
        isLoading: false,
        reset: vi.fn(),
      } as never;
    }) as never);

    renderInTheme(<DlqScreen />);

    fireEvent.click(screen.getAllByTestId(`dlq-replay-${liveEntry.id}`)[0]);

    await waitFor(() => {
      expect(refetch).toHaveBeenCalled();
    });
  });

  it("keeps the button disabled with the deleted-connection tooltip when the server returns connection_deleted", async () => {
    /*
     * Test the rendered behavior: when the entry's connection is
     * soft-deleted on first paint, the button is already disabled with
     * the tooltip — the operator never gets to click. This is the
     * primary visual guarantee from R12. The error-recovery path (server
     * returns `connection_deleted` for an entry whose connection JUST got
     * deleted between fetch and click) is handled by the same disabled
     * logic on the next refetch.
     */
    wireListQueries([softDeletedEntry], [liveConnection, softDeletedConnection]);

    renderInTheme(<DlqScreen />);

    const wrapper = screen.getByTestId(`dlq-replay-tooltip-${softDeletedEntry.id}`);
    const button = screen.getAllByTestId(
      `dlq-replay-${softDeletedEntry.id}`,
    )[0] as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(wrapper.getAttribute("title") ?? "").toContain("restore or hard-delete");
  });

  it("re-disables the button if the operator clicks Replay and the server returns connection_deleted", async () => {
    /*
     * Simulates a time-of-check / time-of-use: the connection was live on initial render but
     * got deleted before the operator clicked Replay. Server returns
     * `connection_deleted` and the UI flips the button to disabled.
     */
    wireListQueries([liveEntry], [liveConnection]);

    let onErrorCb: ((err: { message?: string }, variables: unknown) => void) | undefined;

    vi.mocked(trpcClient.dlq.replay.useMutation).mockImplementation(((opts: {
      onError?: (err: { message?: string }, variables: unknown) => void;
    }) => {
      onErrorCb = opts?.onError;

      return {
        mutate: (vars: unknown) => {
          onErrorCb?.(
            { message: "connection_deleted: Connection is soft-deleted — replay refused" },
            vars,
          );
        },
        mutateAsync: vi.fn(),
        isLoading: false,
        reset: vi.fn(),
      } as never;
    }) as never);

    renderInTheme(<DlqScreen />);

    fireEvent.click(screen.getAllByTestId(`dlq-replay-${liveEntry.id}`)[0]);

    await waitFor(() => {
      const button = screen.getAllByTestId(`dlq-replay-${liveEntry.id}`)[0] as HTMLButtonElement;

      expect(button.disabled).toBe(true);
    });

    const wrapper = screen.getByTestId(`dlq-replay-tooltip-${liveEntry.id}`);

    expect(wrapper.getAttribute("title") ?? "").toContain("Connection deleted");
  });
});

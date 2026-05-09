/**
 * T37 — `<WebhookHealthScreen />` behavioral tests.
 *
 * Confirms:
 *   - renders rows returned by stubbed `webhookLog.list` tRPC
 *   - filters by direction trigger a re-list with the new `direction` param
 *   - "View payload" button toggles an inline panel and calls `getPayload`
 *     to fetch the redacted JSON on demand
 */
import { ThemeProvider } from "@saleor/macaw-ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { WebhookHealthScreen } from "./webhook-health-screen";

vi.mock("@/modules/trpc/trpc-client", () => ({
  trpcClient: {
    connections: {
      list: { useQuery: vi.fn() },
    },
    webhookLog: {
      list: { useQuery: vi.fn() },
      getPayload: { useMutation: vi.fn() },
    },
  },
}));

vi.mock("@saleor/apps-shared/use-dashboard-notification", () => ({
  useDashboardNotification: () => ({
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
  }),
}));

const baseRow = {
  id: "log-1",
  connectionId: "conn-prod",
  direction: "fief_to_saleor" as const,
  eventId: "evt-1",
  eventType: "user.created",
  status: "ok" as const,
  attempts: 1,
  lastError: undefined,
  createdAt: "2026-05-01T00:00:00.000Z",
};

const renderInTheme = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

describe("WebhookHealthScreen", () => {
  beforeEach(() => {
    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [],
      isFetching: false,
      isFetched: true,
    } as never);

    vi.mocked(trpcClient.webhookLog.list.useQuery).mockReturnValue({
      data: { rows: [baseRow] },
      isFetching: false,
      isFetched: true,
      refetch: vi.fn(),
    } as never);

    vi.mocked(trpcClient.webhookLog.getPayload.useMutation).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => ({ payloadRedacted: { hello: "world" } })),
      isLoading: false,
      data: undefined,
      reset: vi.fn(),
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a row per webhook event returned by the stub", () => {
    renderInTheme(<WebhookHealthScreen />);

    expect(screen.getByTestId(`webhook-log-row-${baseRow.id}`)).toBeTruthy();
    expect(screen.getByText(/user\.created/)).toBeTruthy();
  });

  it("re-issues the list query with the new `direction` filter when the operator picks one", async () => {
    renderInTheme(<WebhookHealthScreen />);

    fireEvent.change(screen.getByTestId("webhook-log-filter-direction"), {
      target: { value: "saleor_to_fief" },
    });

    await waitFor(() => {
      // useQuery was called with an updated direction filter.
      const calls = vi.mocked(trpcClient.webhookLog.list.useQuery).mock.calls;
      const last = calls[calls.length - 1] as [Record<string, unknown> | undefined, ...unknown[]];

      expect(last?.[0]?.direction).toBe("saleor_to_fief");
    });
  });

  it("re-issues the list query with the new `status` filter when the operator picks one", async () => {
    renderInTheme(<WebhookHealthScreen />);

    fireEvent.change(screen.getByTestId("webhook-log-filter-status"), {
      target: { value: "dead" },
    });

    await waitFor(() => {
      const calls = vi.mocked(trpcClient.webhookLog.list.useQuery).mock.calls;
      const last = calls[calls.length - 1] as [Record<string, unknown> | undefined, ...unknown[]];

      expect(last?.[0]?.status).toBe("dead");
    });
  });

  it("toggles the payload panel and calls getPayload when 'View payload' is clicked", async () => {
    const mutateAsync = vi.fn(async () => ({ payloadRedacted: { hello: "world" } }));

    vi.mocked(trpcClient.webhookLog.getPayload.useMutation).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync,
      isLoading: false,
      data: undefined,
      reset: vi.fn(),
    } as never);

    renderInTheme(<WebhookHealthScreen />);

    fireEvent.click(screen.getAllByTestId(`webhook-log-view-payload-${baseRow.id}`)[0]);

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ id: baseRow.id });
    });

    await waitFor(() => {
      const panel = screen.getByTestId(`webhook-log-payload-${baseRow.id}`);

      expect(panel).toBeTruthy();
      expect(panel.textContent ?? "").toContain("hello");
    });
  });

  it("hides the payload panel when 'Hide payload' is clicked again", async () => {
    renderInTheme(<WebhookHealthScreen />);

    /* Open the panel. */
    fireEvent.click(screen.getAllByTestId(`webhook-log-view-payload-${baseRow.id}`)[0]);

    await waitFor(() => {
      expect(screen.queryByTestId(`webhook-log-payload-${baseRow.id}`)).not.toBeNull();
    });

    /* Toggle closed. */
    fireEvent.click(screen.getAllByTestId(`webhook-log-view-payload-${baseRow.id}`)[0]);

    await waitFor(() => {
      expect(screen.queryByTestId(`webhook-log-payload-${baseRow.id}`)).toBeNull();
    });
  });
});

/**
 * T38 — `<ReconciliationStatusScreen />` behavioral tests.
 *
 * Confirms:
 *   - lists past runs with status badges (ok / failed / running)
 *   - "Run now" button calls `runs.triggerOnDemand`
 *   - "Run now" is disabled while the most recent run for the selected
 *     connection has `status === "running"`
 *   - `already_running` outcome surfaces a "Already running" toast
 *   - the `flags.getForInstall` row renders a banner with the reason
 *   - empty state shows when there are no runs
 *
 * tRPC client is mocked at the module-singleton seam (matches T35/T36 tests).
 */
import { ThemeProvider } from "@saleor/macaw-ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RedactedProviderConnection } from "@/modules/provider-connections/trpc-router";
import { trpcClient } from "@/modules/trpc/trpc-client";

import { ReconciliationStatusScreen } from "./reconciliation-status-screen";

vi.mock("@/modules/trpc/trpc-client", () => ({
  trpcClient: {
    connections: {
      list: { useQuery: vi.fn() },
    },
    reconciliation: {
      runs: {
        listForConnection: { useQuery: vi.fn() },
        triggerOnDemand: { useMutation: vi.fn() },
      },
      flags: {
        getForInstall: { useQuery: vi.fn() },
      },
    },
  },
}));

const notifySuccessMock = vi.fn();
const notifyErrorMock = vi.fn();
const notifyInfoMock = vi.fn();

vi.mock("@saleor/apps-shared/use-dashboard-notification", () => ({
  useDashboardNotification: () => ({
    notifySuccess: notifySuccessMock,
    notifyError: notifyErrorMock,
    notifyInfo: notifyInfoMock,
  }),
}));

const conn: RedactedProviderConnection = {
  id: "11111111-1111-4111-8111-111111111111",
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

const renderInTheme = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

const wireConnections = (rows: RedactedProviderConnection[]) => {
  vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
    data: rows,
    isFetching: false,
    isFetched: true,
  } as never);
};

const wireRuns = (rows: unknown[]) => {
  vi.mocked(trpcClient.reconciliation.runs.listForConnection.useQuery).mockReturnValue({
    data: rows,
    isFetching: false,
    isFetched: true,
    refetch: vi.fn(),
  } as never);
};

const wireFlag = (flag: unknown) => {
  vi.mocked(trpcClient.reconciliation.flags.getForInstall.useQuery).mockReturnValue({
    data: flag,
    isFetching: false,
    isFetched: true,
    refetch: vi.fn(),
  } as never);
};

const wireTrigger = (mutate: (input: unknown) => void = vi.fn(), isLoading = false) => {
  vi.mocked(trpcClient.reconciliation.runs.triggerOnDemand.useMutation).mockReturnValue({
    mutate,
    isLoading,
  } as never);
};

describe("ReconciliationStatusScreen", () => {
  beforeEach(() => {
    wireConnections([conn]);
    wireFlag(null);
    wireRuns([]);
    wireTrigger();
    notifySuccessMock.mockReset();
    notifyErrorMock.mockReset();
    notifyInfoMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders an empty state when there are no runs", () => {
    renderInTheme(<ReconciliationStatusScreen />);

    expect(screen.getByTestId("reconciliation-runs-empty")).toBeTruthy();
  });

  it("renders past runs with the correct status badges", () => {
    wireRuns([
      {
        id: "row-ok",
        saleorApiUrl: conn.saleorApiUrl,
        connectionId: conn.id,
        startedAt: new Date("2026-05-09T00:00:00Z").toISOString(),
        completedAt: new Date("2026-05-09T00:00:30Z").toISOString(),
        status: "ok",
        summary: { total: 5, repaired: 3, skipped: 2, failed: 0 },
        perRowErrors: [],
      },
      {
        id: "row-failed",
        saleorApiUrl: conn.saleorApiUrl,
        connectionId: conn.id,
        startedAt: new Date("2026-05-09T00:01:00Z").toISOString(),
        completedAt: new Date("2026-05-09T00:01:10Z").toISOString(),
        status: "failed",
        summary: { total: 4, repaired: 2, skipped: 0, failed: 2 },
        perRowErrors: [],
        runError: "drift detector threw",
      },
      {
        id: "row-running",
        saleorApiUrl: conn.saleorApiUrl,
        connectionId: conn.id,
        startedAt: new Date("2026-05-09T00:02:00Z").toISOString(),
        completedAt: null,
        status: "running",
        summary: { total: 0, repaired: 0, skipped: 0, failed: 0 },
        perRowErrors: [],
      },
    ]);

    renderInTheme(<ReconciliationStatusScreen />);

    expect(screen.getByTestId("reconciliation-run-row-row-ok")).toBeTruthy();
    expect(screen.getByTestId("reconciliation-run-row-row-failed")).toBeTruthy();
    expect(screen.getByTestId("reconciliation-run-row-row-running")).toBeTruthy();

    expect(screen.getByTestId("reconciliation-run-status-ok")).toBeTruthy();
    expect(screen.getByTestId("reconciliation-run-status-failed")).toBeTruthy();
    expect(screen.getByTestId("reconciliation-run-status-running")).toBeTruthy();
  });

  it("calls triggerOnDemand when the operator clicks Run now", async () => {
    const mutate = vi.fn();

    wireTrigger(mutate);
    renderInTheme(<ReconciliationStatusScreen />);

    screen.getAllByTestId("reconciliation-run-now-button").forEach((el) => fireEvent.click(el));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledTimes(1);
    });
    expect(mutate.mock.calls[0][0]).toStrictEqual({ connectionId: conn.id });
  });

  it("disables Run now while the latest run for the selected connection is running", () => {
    wireRuns([
      {
        id: "row-running",
        saleorApiUrl: conn.saleorApiUrl,
        connectionId: conn.id,
        startedAt: new Date("2026-05-09T00:02:00Z").toISOString(),
        completedAt: null,
        status: "running",
        summary: { total: 0, repaired: 0, skipped: 0, failed: 0 },
        perRowErrors: [],
      },
    ]);

    renderInTheme(<ReconciliationStatusScreen />);

    const buttons = screen.getAllByTestId("reconciliation-run-now-button");

    /*
     * Macaw spreads testid to wrapper + inner native button; the inner native
     * button is the one whose `disabled` reflects the prop.
     */
    const nativeButton = buttons.find((b) => b.tagName === "BUTTON") as
      | HTMLButtonElement
      | undefined;

    expect(nativeButton).toBeDefined();
    expect(nativeButton?.disabled).toBe(true);
  });

  it("surfaces an info toast when triggerOnDemand returns already_running", async () => {
    let onSuccess: ((data: unknown) => void) | undefined;
    const mutate = vi.fn();

    vi.mocked(trpcClient.reconciliation.runs.triggerOnDemand.useMutation).mockImplementation(((
      opts: { onSuccess?: (data: unknown) => void } = {},
    ) => {
      onSuccess = opts.onSuccess;

      return {
        mutate,
        isLoading: false,
      };
    }) as never);

    renderInTheme(<ReconciliationStatusScreen />);

    screen.getAllByTestId("reconciliation-run-now-button").forEach((el) => fireEvent.click(el));

    expect(onSuccess).toBeDefined();
    onSuccess?.({ outcome: "already_running", activeRunId: "run-in-flight" });

    await waitFor(() => {
      expect(notifyInfoMock).toHaveBeenCalledTimes(1);
    });

    /*
     * First toast — operator should NOT be able to spam it. A second click +
     * a second already_running response should not produce a second toast in
     * quick succession (we throttle by collapsing identical-active-run toasts).
     */
    onSuccess?.({ outcome: "already_running", activeRunId: "run-in-flight" });
    await waitFor(() => {
      expect(notifyInfoMock).toHaveBeenCalledTimes(1);
    });
  });

  it("renders the reconciliation-recommended banner when a flag is active", () => {
    wireFlag({
      saleorApiUrl: conn.saleorApiUrl,
      reason: "user_field.updated:abc",
      raisedByEventId: "evt-1",
      raisedAt: new Date("2026-05-09T00:00:00Z").toISOString(),
      clearedAt: null,
    });

    renderInTheme(<ReconciliationStatusScreen />);

    expect(screen.getByTestId("reconciliation-recommended-banner")).toBeTruthy();
    expect(screen.getByTestId("reconciliation-recommended-banner").textContent).toMatch(
      /user_field\.updated:abc/,
    );
  });

  it("hides the banner after a successful run triggers a flag re-fetch", async () => {
    let onSuccess: ((data: unknown) => void) | undefined;
    const mutate = vi.fn();
    const flagRefetch = vi.fn();

    vi.mocked(trpcClient.reconciliation.flags.getForInstall.useQuery).mockReturnValue({
      data: {
        saleorApiUrl: conn.saleorApiUrl,
        reason: "user_field.updated:abc",
        raisedByEventId: "evt-1",
        raisedAt: new Date("2026-05-09T00:00:00Z").toISOString(),
        clearedAt: null,
      },
      isFetching: false,
      isFetched: true,
      refetch: flagRefetch,
    } as never);

    vi.mocked(trpcClient.reconciliation.runs.triggerOnDemand.useMutation).mockImplementation(((
      opts: { onSuccess?: (data: unknown) => void } = {},
    ) => {
      onSuccess = opts.onSuccess;

      return {
        mutate,
        isLoading: false,
      };
    }) as never);

    renderInTheme(<ReconciliationStatusScreen />);

    expect(screen.getByTestId("reconciliation-recommended-banner")).toBeTruthy();

    // Successful run — should trigger a re-fetch of the flag (and the runs list).
    onSuccess?.({
      outcome: "ok",
      runId: "run-fresh",
      summary: { total: 1, repaired: 1, skipped: 0, failed: 0 },
      finalStatus: "ok",
    });

    await waitFor(() => {
      expect(flagRefetch).toHaveBeenCalled();
    });
  });

  it("shows empty-connections state when there are no connections at all", () => {
    wireConnections([]);

    renderInTheme(<ReconciliationStatusScreen />);

    expect(screen.getByTestId("reconciliation-no-connections")).toBeTruthy();
  });
});

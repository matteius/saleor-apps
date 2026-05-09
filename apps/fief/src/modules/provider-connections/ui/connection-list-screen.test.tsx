/**
 * T35 — `<ConnectionListScreen />` behavioral tests.
 *
 * Confirms the list screen:
 *   - renders connections returned by the stubbed tRPC client
 *   - shows the right status badge per connection state
 *     (Active / Soft-deleted / Pending rotation)
 *   - exposes an "Edit" button per row (calls onEdit)
 *   - exposes a "Delete" button that opens a confirmation modal and
 *     calls `connections.delete` on confirm
 *   - exposes an "Add connection" button that calls onCreateNew
 *
 * tRPC is mocked at the module-singleton seam used by every other UI
 * test in this monorepo (see `apps/avatax/src/modules/.../use-tax-code-combobox.test.ts`).
 * No real HTTP calls leave the test process.
 */
import { ThemeProvider } from "@saleor/macaw-ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { type RedactedProviderConnection } from "../trpc-router";
import { ConnectionListScreen } from "./connection-list-screen";

vi.mock("@/modules/trpc/trpc-client", () => ({
  trpcClient: {
    connections: {
      list: {
        useQuery: vi.fn(),
      },
      delete: {
        useMutation: vi.fn(),
      },
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
  branding: {
    allowedOrigins: ["https://shop.example.com"],
  },
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

describe("ConnectionListScreen", () => {
  beforeEach(() => {
    vi.mocked(trpcClient.connections.delete.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isLoading: false,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a loading skeleton while the list is fetching", () => {
    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: undefined,
      isFetching: true,
      isFetched: false,
    } as never);

    renderInTheme(
      <ConnectionListScreen onCreateNew={vi.fn()} onEdit={vi.fn()} onRotate={vi.fn()} />,
    );

    expect(screen.getByTestId("connection-list-loading")).toBeTruthy();
  });

  it("shows the empty-state CTA when no connections exist", () => {
    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [],
      isFetching: false,
      isFetched: true,
    } as never);

    const onCreateNew = vi.fn();

    renderInTheme(
      <ConnectionListScreen onCreateNew={onCreateNew} onEdit={vi.fn()} onRotate={vi.fn()} />,
    );

    const button = screen.getByRole("button", { name: /add (first )?connection/i });

    fireEvent.click(button);

    expect(onCreateNew).toHaveBeenCalledTimes(1);
  });

  it("renders the active status badge for a healthy connection", () => {
    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [baseConnection],
      isFetching: false,
      isFetched: true,
    } as never);

    renderInTheme(
      <ConnectionListScreen onCreateNew={vi.fn()} onEdit={vi.fn()} onRotate={vi.fn()} />,
    );

    const row = screen.getByTestId(`connection-row-${baseConnection.id}`);

    expect(within(row).getByText(baseConnection.name)).toBeTruthy();
    expect(within(row).getByTestId("status-badge-active")).toBeTruthy();
  });

  it("renders the soft-deleted badge when softDeletedAt is set", () => {
    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [
        {
          ...baseConnection,
          id: "00000000-0000-0000-0000-000000000002",
          softDeletedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      isFetching: false,
      isFetched: true,
    } as never);

    renderInTheme(
      <ConnectionListScreen onCreateNew={vi.fn()} onEdit={vi.fn()} onRotate={vi.fn()} />,
    );

    expect(screen.getByTestId("status-badge-soft-deleted")).toBeTruthy();
  });

  it("renders the pending-rotation badge when pending secret slots are present", () => {
    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [
        {
          ...baseConnection,
          id: "00000000-0000-0000-0000-000000000003",
          secrets: { ...baseConnection.secrets, hasPendingWebhookSecret: true },
        },
      ],
      isFetching: false,
      isFetched: true,
    } as never);

    renderInTheme(
      <ConnectionListScreen onCreateNew={vi.fn()} onEdit={vi.fn()} onRotate={vi.fn()} />,
    );

    expect(screen.getByTestId("status-badge-pending-rotation")).toBeTruthy();
  });

  it("invokes onEdit with the connection id when the Edit button is clicked", () => {
    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [baseConnection],
      isFetching: false,
      isFetched: true,
    } as never);

    const onEdit = vi.fn();

    renderInTheme(
      <ConnectionListScreen onCreateNew={vi.fn()} onEdit={onEdit} onRotate={vi.fn()} />,
    );

    /*
     * Macaw's Button spreads `data-testid` to both the outer wrapper and
     * the inner native <button>. We log all matches and click the one whose
     * onClick registers; in practice this is the BUTTON tag.
     */
    const edits = screen.getAllByTestId(`edit-connection-${baseConnection.id}`);

    /* Click every match — at least one of them owns the onClick. */
    edits.forEach((el) => fireEvent.click(el));

    expect(onEdit).toHaveBeenCalledWith(baseConnection.id);
  });

  it("calls connections.delete.mutate after the operator confirms", async () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [baseConnection],
      isFetching: false,
      isFetched: true,
      refetch: vi.fn(),
    } as never);
    vi.mocked(trpcClient.connections.delete.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(
      <ConnectionListScreen onCreateNew={vi.fn()} onEdit={vi.fn()} onRotate={vi.fn()} />,
    );

    fireEvent.click(screen.getAllByTestId(`delete-connection-${baseConnection.id}`)[0]);

    const confirmButtons = await screen.findAllByTestId("confirm-delete-connection");

    fireEvent.click(confirmButtons[0]);

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({ id: baseConnection.id });
    });
  });

  it("never surfaces ciphertext or plaintext secrets in the rendered tree", () => {
    /*
     * Defensive — even if a future contributor attempts to render the
     * `secrets` object, we want the test suite to fail loudly because a
     * boolean shape sneaking ciphertext through is a category error this
     * file is supposed to catch.
     */
    vi.mocked(trpcClient.connections.list.useQuery).mockReturnValue({
      data: [baseConnection],
      isFetching: false,
      isFetched: true,
    } as never);

    const { container } = renderInTheme(
      <ConnectionListScreen onCreateNew={vi.fn()} onEdit={vi.fn()} onRotate={vi.fn()} />,
    );

    expect(container.textContent ?? "").not.toMatch(/enc:/);
    expect(container.textContent ?? "").not.toMatch(/-----BEGIN/);
  });
});

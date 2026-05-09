/**
 * T35 — `<ConnectionFormScreen />` behavioral tests.
 *
 * Confirms:
 *   - submitting valid input calls `connections.create.mutate` with the
 *     transformed payload (the form translates "comma-separated origins"
 *     to a string array)
 *   - validation errors from the Zod resolver block submission and surface
 *     human-readable messages
 *   - the "Test connection" button calls `connections.testConnection`
 *     with the operator-supplied baseUrl + adminToken
 */
import { ThemeProvider } from "@saleor/macaw-ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { ConnectionFormScreen } from "./connection-form-screen";

vi.mock("@/modules/trpc/trpc-client", () => ({
  trpcClient: {
    connections: {
      create: { useMutation: vi.fn() },
      update: { useMutation: vi.fn() },
      testConnection: { useMutation: vi.fn() },
    },
  },
}));

vi.mock("@saleor/apps-shared/use-dashboard-notification", () => ({
  useDashboardNotification: () => ({
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
  }),
}));

/*
 * The trpcClient mock above is initialized once at module-evaluation time,
 * but because `mockReset: true` runs in this app's vitest config, all `vi.fn`
 * implementations + return values are wiped before every test. So we defer
 * default returns into `beforeEach` instead of declaring intermediate
 * `mockReturnValue`s at module scope.
 */

const renderInTheme = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

const fillRequiredFields = () => {
  fireEvent.change(screen.getByLabelText(/connection name/i), {
    target: { value: "Production Fief" },
  });
  fireEvent.change(screen.getByLabelText(/fief base url/i), {
    target: { value: "https://fief.example.com" },
  });
  fireEvent.change(screen.getByLabelText(/fief tenant id/i), {
    target: { value: "default-tenant" },
  });
  fireEvent.change(screen.getByLabelText(/fief admin token/i), {
    target: { value: "admin-token-123" },
  });
  fireEvent.change(screen.getByLabelText(/oidc client name/i), {
    target: { value: "saleor-storefront" },
  });
  fireEvent.change(screen.getByLabelText(/redirect uris/i), {
    target: { value: "https://shop.example.com/callback" },
  });
  fireEvent.change(screen.getByLabelText(/allowed origins/i), {
    target: { value: "https://shop.example.com" },
  });
  fireEvent.change(screen.getByLabelText(/webhook receiver base url/i), {
    target: { value: "https://app.example.com" },
  });
};

describe("ConnectionFormScreen", () => {
  beforeEach(() => {
    vi.mocked(trpcClient.connections.create.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isLoading: false,
    } as never);
    vi.mocked(trpcClient.connections.update.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isLoading: false,
    } as never);
    vi.mocked(trpcClient.connections.testConnection.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isLoading: false,
      data: null,
    } as never);
  });

  it("submits valid input by calling connections.create.mutate with the transformed payload", async () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.connections.create.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(<ConnectionFormScreen mode="create" onCancel={vi.fn()} onSaved={vi.fn()} />);

    fillRequiredFields();

    screen.getAllByTestId("connection-form-submit").forEach((el) => fireEvent.click(el));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledTimes(1);
    });

    const arg = mutate.mock.calls[0][0];

    expect(arg.name).toBe("Production Fief");
    expect(arg.fief.baseUrl).toBe("https://fief.example.com");
    expect(arg.fief.tenantId).toBe("default-tenant");
    expect(arg.fief.adminToken).toBe("admin-token-123");
    expect(arg.fief.clientName).toBe("saleor-storefront");
    expect(arg.fief.redirectUris).toStrictEqual(["https://shop.example.com/callback"]);
    expect(arg.branding.allowedOrigins).toStrictEqual(["https://shop.example.com"]);
    expect(arg.webhookReceiverBaseUrl).toBe("https://app.example.com");
  });

  it("surfaces a validation error and blocks submission when required fields are missing", async () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.connections.create.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(<ConnectionFormScreen mode="create" onCancel={vi.fn()} onSaved={vi.fn()} />);

    /* leave Name blank, fill the rest so we isolate the error to one field */
    fireEvent.change(screen.getByLabelText(/fief base url/i), {
      target: { value: "https://fief.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/fief tenant id/i), {
      target: { value: "default-tenant" },
    });
    fireEvent.change(screen.getByLabelText(/fief admin token/i), {
      target: { value: "admin-token-123" },
    });
    fireEvent.change(screen.getByLabelText(/oidc client name/i), {
      target: { value: "saleor-storefront" },
    });
    fireEvent.change(screen.getByLabelText(/redirect uris/i), {
      target: { value: "https://shop.example.com/callback" },
    });
    fireEvent.change(screen.getByLabelText(/allowed origins/i), {
      target: { value: "https://shop.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/webhook receiver base url/i), {
      target: { value: "https://app.example.com" },
    });

    screen.getAllByTestId("connection-form-submit").forEach((el) => fireEvent.click(el));

    await waitFor(() => {
      expect(screen.getByTestId("connection-form-error-name")).toBeTruthy();
    });

    expect(mutate).not.toHaveBeenCalled();
  });

  it("rejects invalid URL input and surfaces a Zod URL error", async () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.connections.create.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
    } as never);

    renderInTheme(<ConnectionFormScreen mode="create" onCancel={vi.fn()} onSaved={vi.fn()} />);

    fillRequiredFields();
    fireEvent.change(screen.getByLabelText(/fief base url/i), {
      target: { value: "not-a-url" },
    });

    screen.getAllByTestId("connection-form-submit").forEach((el) => fireEvent.click(el));

    await waitFor(() => {
      expect(screen.getByTestId("connection-form-error-fief-base-url")).toBeTruthy();
    });

    expect(mutate).not.toHaveBeenCalled();
  });

  it("calls connections.testConnection.mutate when the Test button is clicked", () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.connections.testConnection.useMutation).mockReturnValue({
      mutate,
      isLoading: false,
      data: null,
    } as never);

    renderInTheme(<ConnectionFormScreen mode="create" onCancel={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/fief base url/i), {
      target: { value: "https://fief.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/fief admin token/i), {
      target: { value: "admin-token-123" },
    });

    screen.getAllByTestId("test-connection-button").forEach((el) => fireEvent.click(el));

    expect(mutate).toHaveBeenCalledWith({
      baseUrl: "https://fief.example.com",
      adminToken: "admin-token-123",
    });
  });
});

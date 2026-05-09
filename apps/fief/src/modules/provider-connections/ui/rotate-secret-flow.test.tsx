/**
 * T35 — `<RotateSecretFlow />` behavioral tests.
 *
 * Confirms the two-step UI:
 *   - stage 1: clicking "Initiate rotation" calls `connections.rotateSecret`
 *     with the operator-supplied source (locally-generated or operator-supplied)
 *   - on success the flow displays the one-time webhook plaintext and asks the
 *     operator to verify before promoting
 *   - stage 2: clicking "Confirm rotation" calls `connections.confirmRotation`
 *     with the connection id
 */
import { ThemeProvider } from "@saleor/macaw-ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { type RedactedProviderConnection } from "../trpc-router";
import { RotateSecretFlow } from "./rotate-secret-flow";

vi.mock("@/modules/trpc/trpc-client", () => ({
  trpcClient: {
    connections: {
      rotateSecret: { useMutation: vi.fn() },
      confirmRotation: { useMutation: vi.fn() },
      cancelRotation: { useMutation: vi.fn() },
    },
  },
}));

vi.mock("@saleor/apps-shared/use-dashboard-notification", () => ({
  useDashboardNotification: () => ({
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
  }),
}));

const renderInTheme = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

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

describe("RotateSecretFlow", () => {
  beforeEach(() => {
    vi.mocked(trpcClient.connections.rotateSecret.useMutation).mockReturnValue({
      mutate: vi.fn(),
      reset: vi.fn(),
      isLoading: false,
      data: null,
    } as never);
    vi.mocked(trpcClient.connections.confirmRotation.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isLoading: false,
    } as never);
    vi.mocked(trpcClient.connections.cancelRotation.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isLoading: false,
    } as never);
  });

  afterEach(() => {
    /*
     * `mockReset: true` resets mocks but does NOT unmount React trees from
     * previous renders — that's what `cleanup()` is for. Without it, queries
     * across renders pick up stale DOM and `getBy*` returns multiple matches.
     */
    cleanup();
  });

  it("stage 1 — calls rotateSecret with locally-generated mode by default", () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.connections.rotateSecret.useMutation).mockReturnValue({
      mutate,
      reset: vi.fn(),
      isLoading: false,
      data: null,
    } as never);

    renderInTheme(<RotateSecretFlow connection={baseConnection} onClose={vi.fn()} />);

    screen.getAllByTestId("initiate-rotation-button").forEach((el) => fireEvent.click(el));

    expect(mutate).toHaveBeenCalledWith({
      id: baseConnection.id,
      clientSecretSource: { mode: "locally-generated" },
    });
  });

  it("stage 1 — calls rotateSecret with operator-supplied secret when checked", () => {
    const mutate = vi.fn();

    vi.mocked(trpcClient.connections.rotateSecret.useMutation).mockReturnValue({
      mutate,
      reset: vi.fn(),
      isLoading: false,
      data: null,
    } as never);

    renderInTheme(<RotateSecretFlow connection={baseConnection} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("operator-supplied-toggle"));
    fireEvent.change(screen.getByLabelText(/new client secret/i), {
      target: { value: "new-client-secret-123" },
    });

    /*
     * Macaw's Button spreads data-testid to multiple elements; click every
     * match so the inner native <button>'s onClick fires reliably.
     */
    screen.getAllByTestId("initiate-rotation-button").forEach((el) => fireEvent.click(el));

    expect(mutate).toHaveBeenCalledWith({
      id: baseConnection.id,
      clientSecretSource: {
        mode: "operator-supplied",
        newClientSecret: "new-client-secret-123",
      },
    });
  });

  it("stage 2 — surfaces the one-time webhook plaintext and the Confirm button after stage 1", async () => {
    const newWebhookSecretPlaintext = "wh-secret-shown-once-12345";

    vi.mocked(trpcClient.connections.rotateSecret.useMutation).mockReturnValue({
      mutate: vi.fn(),
      reset: vi.fn(),
      isLoading: false,
      data: {
        connection: {
          ...baseConnection,
          secrets: { ...baseConnection.secrets, hasPendingWebhookSecret: true },
        },
        newWebhookSecretPlaintext,
      },
    } as never);

    renderInTheme(<RotateSecretFlow connection={baseConnection} onClose={vi.fn()} />);

    expect(screen.getByTestId("pending-webhook-secret").textContent).toContain(
      newWebhookSecretPlaintext,
    );
    expect(screen.getByTestId("confirm-rotation-button")).toBeTruthy();
    /*
     * Wire-up follow-up: stage 2 ALSO surfaces a "Cancel rotation" button so
     * the operator can back out before promoting.
     */
    expect(screen.getByTestId("cancel-rotation-button")).toBeTruthy();
  });

  it("stage 2 — calls confirmRotation when the operator promotes the pending secret", async () => {
    const confirmMutate = vi.fn();

    vi.mocked(trpcClient.connections.rotateSecret.useMutation).mockReturnValue({
      mutate: vi.fn(),
      reset: vi.fn(),
      isLoading: false,
      data: {
        connection: {
          ...baseConnection,
          secrets: { ...baseConnection.secrets, hasPendingWebhookSecret: true },
        },
        newWebhookSecretPlaintext: "wh-secret",
      },
    } as never);
    vi.mocked(trpcClient.connections.confirmRotation.useMutation).mockReturnValue({
      mutate: confirmMutate,
      isLoading: false,
    } as never);

    renderInTheme(<RotateSecretFlow connection={baseConnection} onClose={vi.fn()} />);

    screen.getAllByTestId("confirm-rotation-button").forEach((el) => fireEvent.click(el));

    await waitFor(() => {
      expect(confirmMutate).toHaveBeenCalledWith({ id: baseConnection.id });
    });
  });

  it("stage 2 — calls cancelRotation when the operator backs out of the pending rotation", async () => {
    const cancelMutate = vi.fn();

    vi.mocked(trpcClient.connections.rotateSecret.useMutation).mockReturnValue({
      mutate: vi.fn(),
      reset: vi.fn(),
      isLoading: false,
      data: {
        connection: {
          ...baseConnection,
          secrets: { ...baseConnection.secrets, hasPendingWebhookSecret: true },
        },
        newWebhookSecretPlaintext: "wh-secret",
      },
    } as never);
    vi.mocked(trpcClient.connections.cancelRotation.useMutation).mockReturnValue({
      mutate: cancelMutate,
      isLoading: false,
    } as never);

    renderInTheme(<RotateSecretFlow connection={baseConnection} onClose={vi.fn()} />);

    screen.getAllByTestId("cancel-rotation-button").forEach((el) => fireEvent.click(el));

    await waitFor(() => {
      expect(cancelMutate).toHaveBeenCalledWith({ id: baseConnection.id });
    });
  });

  it("cancelRotation onSuccess callback resets the rotateSecret mutation cache (returns UI to stage 1)", () => {
    const rotateReset = vi.fn();

    vi.mocked(trpcClient.connections.rotateSecret.useMutation).mockReturnValue({
      mutate: vi.fn(),
      reset: rotateReset,
      isLoading: false,
      data: {
        connection: {
          ...baseConnection,
          secrets: { ...baseConnection.secrets, hasPendingWebhookSecret: true },
        },
        newWebhookSecretPlaintext: "wh-secret",
      },
    } as never);

    /*
     * Capture the onSuccess hook the component registers with cancelRotation —
     * the production wiring expects rotateMutation.reset() to be called from
     * inside it so the gating expression (`stage2 = rotateMutation.data`)
     * reverts to stage 1 after a successful cancel without forcing the
     * operator to close + reopen the panel.
     */
    let capturedOnSuccess: (() => void) | undefined;

    vi.mocked(trpcClient.connections.cancelRotation.useMutation).mockImplementation(((opts: {
      onSuccess?: () => void;
    }) => {
      capturedOnSuccess = opts?.onSuccess;

      return {
        mutate: vi.fn(),
        isLoading: false,
      };
    }) as never);

    renderInTheme(<RotateSecretFlow connection={baseConnection} onClose={vi.fn()} />);

    expect(capturedOnSuccess).toBeDefined();
    capturedOnSuccess?.();

    expect(rotateReset).toHaveBeenCalledTimes(1);
  });
});

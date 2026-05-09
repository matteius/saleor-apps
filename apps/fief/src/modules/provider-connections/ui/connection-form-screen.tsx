/**
 * T35 — `<ConnectionFormScreen />`.
 *
 * Two modes:
 *   - `mode="create"` — builds a payload for `connections.create`
 *   - `mode="edit"`   — builds a payload for `connections.update`
 *
 * The form uses React Hook Form + Zod resolver per repo convention. Array
 * inputs (allowed origins, redirect URIs) are entered as one-per-line text
 * and split client-side. We mirror the tRPC layer's input schema (T34) so
 * server-side rejection is rare; the server schema remains the source of
 * truth.
 *
 * Sections:
 *   1. Connection details (name, fief.baseUrl, tenantId, adminToken,
 *      OIDC client name, redirect URIs, webhook receiver base URL)
 *   2. Branding (allowed origins)
 *   3. Test connection probe (separate mutation; surfaces a status report)
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useDashboardNotification } from "@saleor/apps-shared/use-dashboard-notification";
import { Box, Button, Text } from "@saleor/macaw-ui";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { trpcClient } from "@/modules/trpc/trpc-client";

import { type RedactedProviderConnection } from "../trpc-router";

/*
 * ---------------------------------------------------------------------------
 * Form schema
 * ---------------------------------------------------------------------------
 */

const splitLines = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const formSchema = z.object({
  name: z.string().min(1, { message: "Name is required" }).max(120),
  fiefBaseUrl: z.string().url({ message: "Must be a valid URL" }),
  fiefTenantId: z.string().min(1, { message: "Tenant id is required" }),
  fiefAdminToken: z.string().min(1, { message: "Admin token is required" }),
  oidcClientName: z.string().min(1, { message: "OIDC client name is required" }),
  redirectUris: z
    .string()
    .min(1, { message: "At least one redirect URI is required" })
    .refine(
      (raw) => {
        const list = splitLines(raw);

        if (list.length === 0) return false;

        return list.every((u) => {
          try {
            new URL(u);

            return true;
          } catch {
            return false;
          }
        });
      },
      { message: "Each line must be a valid URL" },
    ),
  allowedOrigins: z
    .string()
    .min(1, { message: "At least one allowed origin is required" })
    .refine(
      (raw) => {
        const list = splitLines(raw);

        if (list.length === 0) return false;

        return list.every((u) => {
          try {
            new URL(u);

            return true;
          } catch {
            return false;
          }
        });
      },
      { message: "Each line must be a valid URL" },
    ),
  webhookReceiverBaseUrl: z.string().url({ message: "Must be a valid URL" }),
});

type FormShape = z.infer<typeof formSchema>;

/*
 * ---------------------------------------------------------------------------
 * Reusable labelled-input helper using Macaw's primitives + Controller.
 *
 * We deliberately do NOT pull `<Input />` from `@saleor/react-hook-form-macaw`
 * here because the wrapper does not expose `htmlFor`/id — and our tests use
 * `getByLabelText` which requires a real `<label htmlFor>` association.
 * Building this thin wrapper directly keeps DOM accessibility intact.
 * ---------------------------------------------------------------------------
 */

const FieldRow = ({
  label,
  htmlFor,
  errorTestId,
  errorMessage,
  helperText,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  errorTestId?: string;
  errorMessage?: string;
  helperText?: string;
  required?: boolean;
  children: React.ReactNode;
}) => (
  <Box display="flex" flexDirection="column" gap={1}>
    <Box as="label" htmlFor={htmlFor} display="block">
      <Text size={2} color="default1" fontWeight="medium">
        {label}
        {required ? " *" : ""}
      </Text>
    </Box>
    {children}
    {errorMessage ? (
      <Text size={1} color="critical1" data-testid={errorTestId}>
        {errorMessage}
      </Text>
    ) : helperText ? (
      <Text size={1} color="default2">
        {helperText}
      </Text>
    ) : null}
  </Box>
);

const TextInput = ({
  id,
  type = "text",
  value,
  onChange,
  onBlur,
  name,
}: {
  id: string;
  type?: "text" | "password" | "url";
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  name: string;
}) => (
  <Box
    as="input"
    id={id}
    name={name}
    type={type}
    value={value}
    onChange={onChange}
    onBlur={onBlur}
    padding={3}
    borderRadius={3}
    borderWidth={1}
    borderStyle="solid"
    borderColor="default1"
  />
);

const TextAreaInput = ({
  id,
  value,
  onChange,
  onBlur,
  name,
  rows = 3,
}: {
  id: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
  name: string;
  rows?: number;
}) => (
  <Box
    as="textarea"
    id={id}
    name={name}
    value={value}
    onChange={onChange}
    onBlur={onBlur}
    rows={rows}
    padding={3}
    borderRadius={3}
    borderWidth={1}
    borderStyle="solid"
    borderColor="default1"
  />
);

/*
 * ---------------------------------------------------------------------------
 * TestConnection probe — separate mutation
 * ---------------------------------------------------------------------------
 */

const TestConnectionPanel = ({
  baseUrlValue,
  adminTokenValue,
}: {
  baseUrlValue: string;
  adminTokenValue: string;
}) => {
  const { mutate, isLoading, data } = trpcClient.connections.testConnection.useMutation();

  return (
    <Box display="flex" flexDirection="column" gap={3}>
      <Button
        type="button"
        variant="secondary"
        disabled={isLoading || !baseUrlValue || !adminTokenValue}
        data-testid="test-connection-button"
        onClick={() =>
          mutate({
            baseUrl: baseUrlValue,
            adminToken: adminTokenValue,
          })
        }
      >
        {isLoading ? "Probing..." : "Test connection"}
      </Button>
      {data ? (
        <Box
          padding={3}
          borderRadius={3}
          borderWidth={1}
          borderStyle="solid"
          borderColor="default1"
          data-testid="test-connection-report"
        >
          <Text size={2}>OIDC discovery: {data.oidcDiscovery}</Text>
          <Text size={2}>Admin auth: {data.adminAuth}</Text>
          {data.details?.oidcDiscovery ? (
            <Text size={1} color="critical1">
              OIDC error: {data.details.oidcDiscovery}
            </Text>
          ) : null}
          {data.details?.adminAuth ? (
            <Text size={1} color="critical1">
              Admin error: {data.details.adminAuth}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
};

/*
 * ---------------------------------------------------------------------------
 * Main screen
 * ---------------------------------------------------------------------------
 */

export interface ConnectionFormScreenProps {
  mode: "create" | "edit";
  initialConnection?: RedactedProviderConnection | undefined;
  onCancel: () => void;
  onSaved: (connection: RedactedProviderConnection) => void;
}

export const ConnectionFormScreen = (props: ConnectionFormScreenProps) => {
  const { mode, initialConnection, onCancel, onSaved } = props;
  const { notifySuccess, notifyError } = useDashboardNotification();

  const createMutation = trpcClient.connections.create.useMutation({
    onSuccess(saved) {
      notifySuccess("Connection saved");
      onSaved(saved);
    },
    onError(err) {
      notifyError("Failed to save connection", err.message);
    },
  });

  const updateMutation = trpcClient.connections.update.useMutation({
    onSuccess(saved) {
      notifySuccess("Connection updated");
      onSaved(saved);
    },
    onError(err) {
      notifyError("Failed to update connection", err.message);
    },
  });

  const isLoading = createMutation.isLoading || updateMutation.isLoading;

  const {
    handleSubmit,
    control,
    watch,
    formState: { errors },
  } = useForm<FormShape>({
    defaultValues: {
      name: initialConnection?.name ?? "",
      fiefBaseUrl: initialConnection?.fief.baseUrl ?? "",
      fiefTenantId: initialConnection?.fief.tenantId ?? "",
      fiefAdminToken: "",
      oidcClientName: "",
      redirectUris: "",
      allowedOrigins: (initialConnection?.branding.allowedOrigins ?? []).join("\n"),
      webhookReceiverBaseUrl: "",
    },
    resolver: zodResolver(formSchema),
  });

  const onSubmit = (values: FormShape) => {
    if (mode === "create") {
      createMutation.mutate({
        name: values.name,
        fief: {
          baseUrl: values.fiefBaseUrl,
          tenantId: values.fiefTenantId,
          adminToken: values.fiefAdminToken,
          clientName: values.oidcClientName,
          redirectUris: splitLines(values.redirectUris),
        },
        branding: {
          allowedOrigins: splitLines(values.allowedOrigins),
        },
        webhookReceiverBaseUrl: values.webhookReceiverBaseUrl,
        claimMapping: [],
      });

      return;
    }

    if (initialConnection === undefined) {
      notifyError("Cannot update connection", "Missing connection record");

      return;
    }

    updateMutation.mutate({
      id: initialConnection.id,
      patch: {
        name: values.name,
        branding: {
          allowedOrigins: splitLines(values.allowedOrigins),
        },
      },
    });
  };

  const fiefBaseUrlValue = watch("fiefBaseUrl");
  const fiefAdminTokenValue = watch("fiefAdminToken");

  return (
    <Box
      as="form"
      data-testid="connection-form"
      onSubmit={handleSubmit(onSubmit)}
      display="flex"
      flexDirection="column"
      gap={8}
    >
      {/* Section 1 — Connection details */}
      <Box display="flex" flexDirection="column" gap={5}>
        <Text size={5} fontWeight="bold">
          Connection details
        </Text>

        <Controller
          name="name"
          control={control}
          render={({ field }) => (
            <FieldRow
              label="Connection name"
              htmlFor="connection-form-name"
              required
              errorTestId="connection-form-error-name"
              errorMessage={errors.name?.message}
              helperText="Friendly identifier (e.g. 'Production Fief')"
            >
              <TextInput id="connection-form-name" {...field} />
            </FieldRow>
          )}
        />

        <Controller
          name="fiefBaseUrl"
          control={control}
          render={({ field }) => (
            <FieldRow
              label="Fief base URL"
              htmlFor="connection-form-fief-base-url"
              required
              errorTestId="connection-form-error-fief-base-url"
              errorMessage={errors.fiefBaseUrl?.message}
            >
              <TextInput id="connection-form-fief-base-url" type="url" {...field} />
            </FieldRow>
          )}
        />

        <Controller
          name="fiefTenantId"
          control={control}
          render={({ field }) => (
            <FieldRow
              label="Fief tenant id"
              htmlFor="connection-form-fief-tenant-id"
              required
              errorTestId="connection-form-error-fief-tenant-id"
              errorMessage={errors.fiefTenantId?.message}
            >
              <TextInput id="connection-form-fief-tenant-id" {...field} />
            </FieldRow>
          )}
        />

        <Controller
          name="fiefAdminToken"
          control={control}
          render={({ field }) => (
            <FieldRow
              label="Fief admin token"
              htmlFor="connection-form-fief-admin-token"
              required
              errorTestId="connection-form-error-fief-admin-token"
              errorMessage={errors.fiefAdminToken?.message}
              helperText="Stored encrypted at rest. Used to provision the OIDC client + webhook subscriber."
            >
              <TextInput id="connection-form-fief-admin-token" type="password" {...field} />
            </FieldRow>
          )}
        />

        <Controller
          name="oidcClientName"
          control={control}
          render={({ field }) => (
            <FieldRow
              label="OIDC client name"
              htmlFor="connection-form-oidc-client-name"
              required
              errorTestId="connection-form-error-oidc-client-name"
              errorMessage={errors.oidcClientName?.message}
            >
              <TextInput id="connection-form-oidc-client-name" {...field} />
            </FieldRow>
          )}
        />

        <Controller
          name="redirectUris"
          control={control}
          render={({ field }) => (
            <FieldRow
              label="Redirect URIs"
              htmlFor="connection-form-redirect-uris"
              required
              errorTestId="connection-form-error-redirect-uris"
              errorMessage={errors.redirectUris?.message}
              helperText="One URL per line."
            >
              <TextAreaInput id="connection-form-redirect-uris" {...field} />
            </FieldRow>
          )}
        />

        <Controller
          name="webhookReceiverBaseUrl"
          control={control}
          render={({ field }) => (
            <FieldRow
              label="Webhook receiver base URL"
              htmlFor="connection-form-webhook-receiver"
              required
              errorTestId="connection-form-error-webhook-receiver"
              errorMessage={errors.webhookReceiverBaseUrl?.message}
              helperText="Base URL where Fief will deliver user events to this app."
            >
              <TextInput id="connection-form-webhook-receiver" type="url" {...field} />
            </FieldRow>
          )}
        />
      </Box>

      {/* Section 2 — Branding */}
      <Box display="flex" flexDirection="column" gap={5}>
        <Text size={5} fontWeight="bold">
          Branding
        </Text>
        <Controller
          name="allowedOrigins"
          control={control}
          render={({ field }) => (
            <FieldRow
              label="Allowed origins"
              htmlFor="connection-form-allowed-origins"
              required
              errorTestId="connection-form-error-allowed-origins"
              errorMessage={errors.allowedOrigins?.message}
              helperText="One origin per line. Used to gate signed branding params."
            >
              <TextAreaInput id="connection-form-allowed-origins" {...field} />
            </FieldRow>
          )}
        />
      </Box>

      {/* Section 3 — Test connection probe */}
      <Box display="flex" flexDirection="column" gap={3}>
        <Text size={5} fontWeight="bold">
          Test connection
        </Text>
        <Text size={2} color="default2">
          Verifies OIDC discovery + admin-API auth against the Fief base URL.
        </Text>
        <TestConnectionPanel
          baseUrlValue={fiefBaseUrlValue ?? ""}
          adminTokenValue={fiefAdminTokenValue ?? ""}
        />
      </Box>

      {/* Footer */}
      <Box display="flex" justifyContent="space-between" gap={3}>
        <Button
          type="button"
          variant="tertiary"
          onClick={onCancel}
          disabled={isLoading}
          data-testid="connection-form-cancel"
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading} data-testid="connection-form-submit">
          {isLoading ? "Saving..." : mode === "create" ? "Create connection" : "Save changes"}
        </Button>
      </Box>
    </Box>
  );
};

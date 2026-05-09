import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The kill-switch helpers read the typed `env` object (never `process.env` —
 * `n/no-process-env` is enforced). To exercise both states we replace the
 * module with a controllable mock per test via `vi.doMock` + dynamic import,
 * then `vi.resetModules` between cases so the next dynamic import re-evaluates
 * the mock factory.
 */

type EnvShape = {
  FIEF_SYNC_DISABLED: boolean;
  FIEF_SALEOR_TO_FIEF_DISABLED: boolean;
};

const loadKillSwitchesWithEnv = async (overrides: Partial<EnvShape>) => {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      FIEF_SYNC_DISABLED: false,
      FIEF_SALEOR_TO_FIEF_DISABLED: false,
      ...overrides,
    },
  }));

  return import("./kill-switches");
};

afterEach(() => {
  vi.doUnmock("@/lib/env");
  vi.resetModules();
});

describe("isFiefSyncDisabled", () => {
  it("returns true when env.FIEF_SYNC_DISABLED is true", async () => {
    const { isFiefSyncDisabled } = await loadKillSwitchesWithEnv({
      FIEF_SYNC_DISABLED: true,
    });

    expect(isFiefSyncDisabled()).toBe(true);
  });

  it("returns false when env.FIEF_SYNC_DISABLED is false (default)", async () => {
    const { isFiefSyncDisabled } = await loadKillSwitchesWithEnv({
      FIEF_SYNC_DISABLED: false,
    });

    expect(isFiefSyncDisabled()).toBe(false);
  });

  it("does not depend on FIEF_SALEOR_TO_FIEF_DISABLED", async () => {
    const { isFiefSyncDisabled } = await loadKillSwitchesWithEnv({
      FIEF_SYNC_DISABLED: false,
      FIEF_SALEOR_TO_FIEF_DISABLED: true,
    });

    expect(isFiefSyncDisabled()).toBe(false);
  });
});

describe("isSaleorToFiefDisabled", () => {
  it("returns true when env.FIEF_SALEOR_TO_FIEF_DISABLED is true", async () => {
    const { isSaleorToFiefDisabled } = await loadKillSwitchesWithEnv({
      FIEF_SALEOR_TO_FIEF_DISABLED: true,
    });

    expect(isSaleorToFiefDisabled()).toBe(true);
  });

  it("returns false when env.FIEF_SALEOR_TO_FIEF_DISABLED is false (default)", async () => {
    const { isSaleorToFiefDisabled } = await loadKillSwitchesWithEnv({
      FIEF_SALEOR_TO_FIEF_DISABLED: false,
    });

    expect(isSaleorToFiefDisabled()).toBe(false);
  });

  it("does not depend on FIEF_SYNC_DISABLED", async () => {
    const { isSaleorToFiefDisabled } = await loadKillSwitchesWithEnv({
      FIEF_SYNC_DISABLED: true,
      FIEF_SALEOR_TO_FIEF_DISABLED: false,
    });

    expect(isSaleorToFiefDisabled()).toBe(false);
  });
});

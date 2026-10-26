import { describe, expect, it } from "vite-plus/test";
import { type ManagedSandbox, SandboxOperationError } from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  parseSandboxCreateInput,
  parseSandboxCreateDraft,
  unconfirmedSandboxCreate,
  sandboxOperationErrorMessage,
  sandboxCreateWasRejected,
} from "./BoatSandboxesSettings.logic";

const request = {
  provider: "boat",
  requestId: "original-request",
  name: "Development",
  templateId: "clean-tools",
  machineType: "default",
  ttlSeconds: 86400,
} as const;

const sandbox = (overrides: Partial<ManagedSandbox> = {}): ManagedSandbox => ({
  ...request,
  id: "managed-id",
  providerId: null,
  state: "unknown",
  connectionState: "unavailable",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  lastError: null,
  ...overrides,
});

describe("Managed sandbox settings", () => {
  it("pins Namespace to its provider plan limit while preserving Boat's explicit TTL", () => {
    expect(Option.getOrNull(parseSandboxCreateDraft({ ...request, ttlHours: "24" }))).toEqual(
      request,
    );
    expect(
      Option.getOrNull(
        parseSandboxCreateDraft({ ...request, provider: "namespace", ttlHours: "24" }),
      ),
    ).toEqual({ ...request, provider: "namespace", ttlSeconds: 10800 });
  });
  it("retries ambiguous creation with its original identity and immutable inputs", () => {
    expect(unconfirmedSandboxCreate(request, null)).toBe(request);
    expect(unconfirmedSandboxCreate(request, [])).toBe(request);
    expect(unconfirmedSandboxCreate(request, [sandbox({ requestId: "other-request" })])).toBe(
      request,
    );
    expect(unconfirmedSandboxCreate(request, [sandbox({ provider: "namespace" })])).toBe(request);
  });

  it("reconciles persisted failed, unknown and deleted records instead of starting another create", () => {
    for (const state of ["requested", "unknown", "error", "deleted"] as const) {
      expect(unconfirmedSandboxCreate(request, [sandbox({ state })])).toBeNull();
    }
    expect(unconfirmedSandboxCreate(null, null)).toBeNull();
  });

  it("rejects templates and TTLs that cannot be submitted safely", () => {
    expect(Option.isSome(parseSandboxCreateInput(request))).toBe(true);
    expect(Option.isNone(parseSandboxCreateInput({ ...request, templateId: " " }))).toBe(true);
    expect(
      Option.isNone(parseSandboxCreateInput({ ...request, templateId: "x".repeat(256) })),
    ).toBe(true);
    for (const ttlSeconds of [0, 1.5, 2592001, Number.NaN]) {
      expect(Option.isNone(parseSandboxCreateInput({ ...request, ttlSeconds }))).toBe(true);
    }
  });

  it("shows category messages without reflecting provider errors or pairing credentials", () => {
    const secret = "private-api-key-or-pairing-token";
    expect(sandboxOperationErrorMessage(new Error(secret))).not.toContain(secret);
    expect(
      sandboxOperationErrorMessage({
        _tag: "SandboxOperationError",
        category: "authentication",
        message: secret,
      }),
    ).toBe(new SandboxOperationError({ category: "authentication" }).message);
  });

  it("allows correcting a rejected request while retaining uncertain requests for retry", () => {
    expect(sandboxCreateWasRejected(new SandboxOperationError({ category: "invalid_input" }))).toBe(
      true,
    );
    for (const category of ["uncertain", "storage", "unavailable", "conflict"] as const) {
      expect(sandboxCreateWasRejected(new SandboxOperationError({ category }))).toBe(false);
    }
    expect(sandboxCreateWasRejected(new Error("connection lost"))).toBe(false);
  });
});

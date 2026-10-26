import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  namespaceWorktreeAttachments,
  namespaceWorktreeBlockReason,
  namespaceWorktreeRequestId,
  validateNamespaceWorktreeModel,
} from "./namespaceWorktree.logic";
import type { ProviderInstanceEntry } from "../providerInstances";

const allowed = {
  desktopLocalController: true,
  supported: true,
  multipleModels: false,
  sourceContext: false,
  attachments: [],
};
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");

// The validator only reads these catalog fields; the fixture deliberately contains no credentials.
const entry = {
  instanceId,
  driverKind: driver,
  enabled: true,
  installed: true,
  isAvailable: true,
  status: "ready",
  snapshot: { auth: { status: "authenticated" } },
} as ProviderInstanceEntry;
const model = {
  slug: "model",
  name: "Model",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        type: "select" as const,
        label: "Effort",
        options: [{ id: "high", label: "High" }],
      },
    ],
  },
};

describe("Namespace first send", () => {
  it("keeps the same VM request identity across retries and separates different drafts", () => {
    const thread = ThreadId.make("f03aa134-4671-4660-a6c3-e36c77a69e74");
    expect(namespaceWorktreeRequestId(thread)).toBe(
      namespaceWorktreeRequestId(ThreadId.make(String(thread))),
    );
    expect(namespaceWorktreeRequestId(thread)).not.toContain(":");
    expect(namespaceWorktreeRequestId(thread).length).toBeLessThanOrEqual(256);
    expect(namespaceWorktreeRequestId(ThreadId.make("a:b"))).not.toBe(
      namespaceWorktreeRequestId(ThreadId.make("a-b")),
    );
  });
  it("blocks unsupported controllers, multi-model sends and source-bound contexts", () => {
    expect(namespaceWorktreeBlockReason(allowed)).toBeNull();
    expect(namespaceWorktreeBlockReason({ ...allowed, desktopLocalController: false })).toContain(
      "local controller",
    );
    expect(namespaceWorktreeBlockReason({ ...allowed, supported: false })).toContain(
      "local controller",
    );
    expect(namespaceWorktreeBlockReason({ ...allowed, multipleModels: true })).toContain(
      "multiple models",
    );
    expect(namespaceWorktreeBlockReason({ ...allowed, sourceContext: true })).toContain(
      "machine-bound",
    );
  });
  it("does not reuse a source upload ID or mutate the source attachment", () => {
    const attachment = {
      type: "file" as const,
      id: "attachment",
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      file: new File(["x"], "file.txt"),
      uploadedAttachmentId: "source-upload",
    };
    const [remote] = namespaceWorktreeAttachments("request", [attachment]);
    expect(remote).toMatchObject({ id: "request-attachment", file: attachment.file });
    expect(remote).not.toHaveProperty("uploadedAttachmentId");
    expect(attachment.uploadedAttachmentId).toBe("source-upload");
    expect(namespaceWorktreeAttachments("request", [attachment])).toEqual([remote]);
  });
  it("keeps files without local bytes recoverable instead of sending their source ID", () => {
    const attachment = {
      type: "file" as const,
      id: "attachment",
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      file: null,
      uploadedAttachmentId: "source-upload",
    };
    expect(namespaceWorktreeBlockReason({ ...allowed, attachments: [attachment] })).toContain(
      "Reattach",
    );
    expect(() => namespaceWorktreeAttachments("request", [attachment])).toThrow("Reattach");
    expect(attachment.uploadedAttachmentId).toBe("source-upload");
  });
  it("requires the chosen provider, model and options in the destination catalog", () => {
    const input = {
      selection: { instanceId, model: "model", options: [{ id: "effort", value: "high" }] },
      driver,
      entries: [entry],
      models: [model],
    };
    expect(() => validateNamespaceWorktreeModel(input)).not.toThrow();
    expect(() => validateNamespaceWorktreeModel({ ...input, entries: [] })).toThrow("provider");
    expect(() => validateNamespaceWorktreeModel({ ...input, models: [] })).toThrow("model");
    expect(() =>
      validateNamespaceWorktreeModel({
        ...input,
        selection: { ...input.selection, options: [{ id: "effort", value: "max" }] },
      }),
    ).toThrow("option");
    expect(() =>
      validateNamespaceWorktreeModel({ ...input, entries: [{ ...entry, enabled: false }] }),
    ).toThrow("provider");
  });
});

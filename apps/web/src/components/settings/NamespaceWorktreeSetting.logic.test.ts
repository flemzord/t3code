import { expect, it } from "vite-plus/test";
import { namespaceWorktreeSetting } from "./NamespaceWorktreeSetting.logic";

it("saves the explicit image and machine type after trimming", () => {
  expect(namespaceWorktreeSetting("  image:authenticated  ", "large")).toEqual({
    image: "image:authenticated",
    machineType: "large",
  });
});
it("rejects an empty or oversized image before enabling billed worktrees", () => {
  expect(() => namespaceWorktreeSetting(" ", "default")).toThrow("Namespace image");
  expect(() => namespaceWorktreeSetting("a".repeat(256), "default")).toThrow("Namespace image");
});

import type { NamespaceTemplate } from "@t3tools/contracts";
import {
  namespaceTemplateBlockReason,
  namespaceTemplateShape,
} from "./NamespaceWorktreeSetting.logic";

function template(overrides: Partial<NamespaceTemplate> = {}): NamespaceTemplate {
  return {
    id: "saved",
    name: "Authenticated tools",
    version: "v1",
    machineType: "large",
    shape: { virtualCpu: 16, memoryMegabytes: 32768, machineArch: "amd64", os: "linux" },
    machineTypeOverrideSupported: false,
    ttlOverrideSupported: false,
    ttlPolicy: "provider_managed",
    ...overrides,
  };
}

it("requires a loaded supported saved template while allowing manual images without a list", () => {
  expect(namespaceTemplateBlockReason("registry/image:tools", null)).toBeNull();
  expect(namespaceTemplateBlockReason("blueprint:saved", null)).toContain("Load and select");
  expect(namespaceTemplateBlockReason("blueprint:saved", [])).toContain("Load and select");
  expect(namespaceTemplateBlockReason("blueprint:saved", [template()])).toBeNull();
});
it("blocks templates with unknown or unsupported saved machine shapes", () => {
  expect(
    namespaceTemplateBlockReason("blueprint:saved", [template({ machineType: null })]),
  ).toContain("not supported");
  expect(namespaceTemplateBlockReason("blueprint:saved", [template({ shape: null })])).toContain(
    "not supported",
  );
  expect(
    namespaceTemplateBlockReason("blueprint:saved", [
      template({
        shape: { virtualCpu: 16, memoryMegabytes: 32768, machineArch: "arm64", os: "linux" },
      }),
    ]),
  ).toContain("not supported");
});
it("shows the saved template shape and lack of size or duration overrides", () => {
  expect(namespaceTemplateShape(template())).toBe(
    "16 CPU · 32 GiB · amd64 · linux. Saved shape; size and duration overrides are unavailable.",
  );
});

import type { NamespaceWorktreeSettings, SandboxMachineType } from "@t3tools/contracts";

export function namespaceWorktreeSetting(
  image: string,
  machineType: SandboxMachineType,
): NamespaceWorktreeSettings {
  const trimmed = image.trim();
  if (trimmed.length === 0 || trimmed.length > 255)
    throw new Error("Enter a Namespace image with 1 to 255 characters.");
  return { image: trimmed, machineType };
}

export function namespaceTemplateBlockReason(
  image: string,
  templates: ReadonlyArray<import("@t3tools/contracts").NamespaceTemplate> | null,
): string | null {
  if (!image.startsWith("blueprint:")) return null;
  const template = templates?.find((candidate) => `blueprint:${candidate.id}` === image);
  if (!template) return "Load and select an available Namespace template before creating a VM.";
  if (
    !template.machineType ||
    !template.shape ||
    template.shape.os.toLowerCase() !== "linux" ||
    template.shape.machineArch.toLowerCase() !== "amd64"
  )
    return "This template's saved machine shape is not supported. Choose another template or an image.";
  return null;
}

export function namespaceTemplateShape(
  template: import("@t3tools/contracts").NamespaceTemplate,
): string {
  const shape = template.shape;
  return shape
    ? `${shape.virtualCpu} CPU · ${shape.memoryMegabytes / 1024} GiB · ${shape.machineArch} · ${shape.os}. Saved shape; size and duration overrides are unavailable.`
    : "Saved shape unavailable. This template cannot be used.";
}

import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:sandboxes:list",
      tag: WS_METHODS.sandboxesList,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:configure",
      tag: WS_METHODS.sandboxesConfigure,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:create",
      tag: WS_METHODS.sandboxesCreate,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:refresh",
      tag: WS_METHODS.sandboxesRefresh,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:stop",
      tag: WS_METHODS.sandboxesStop,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:resume",
      tag: WS_METHODS.sandboxesResume,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:remove",
      tag: WS_METHODS.sandboxesRemove,
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:connect",
      tag: WS_METHODS.sandboxesConnect,
    }),
  };
}

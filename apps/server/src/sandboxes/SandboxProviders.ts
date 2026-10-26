import * as Context from "effect/Context";
import type { SandboxProvider } from "@t3tools/contracts";
import type { SandboxProviderClient } from "./SandboxProvider.ts";

export class SandboxProviders extends Context.Service<
  SandboxProviders,
  {
    readonly get: (provider: SandboxProvider) => SandboxProviderClient;
  }
>()("t3/sandboxes/SandboxProviders") {}

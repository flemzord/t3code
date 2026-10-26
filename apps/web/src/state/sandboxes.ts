import { createSandboxEnvironmentAtoms } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId, SandboxCreateInput } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const sandboxEnvironment = createSandboxEnvironmentAtoms(connectionAtomRuntime);

// Keep the original request identity when settings unmount during a create.
const sandboxCreateAttempts = Atom.family((key: string) =>
  Atom.make<SandboxCreateInput | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-sandbox-create-attempt:${key}`),
  ),
);

export const sandboxCreateAttemptAtom = (
  environmentId: EnvironmentId,
  provider: SandboxCreateInput["provider"],
) => sandboxCreateAttempts(JSON.stringify([environmentId, provider]));

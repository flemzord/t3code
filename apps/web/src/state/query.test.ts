import { expect, it } from "vite-plus/test";
import { SandboxOperationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { formatEnvironmentQueryError } from "./query";

it("explains a request rejected by an older server after the RPC defect round trip", () => {
  const codec = Schema.Defect();
  const defect = Schema.decodeSync(codec)(
    Schema.encodeSync(codec)("Unknown request tag: namespaceTemplates.list"),
  );
  expect(formatEnvironmentQueryError(Cause.die(defect))).toBe(
    "This T3 server does not support this request. Update and restart the selected environment's server, then reconnect.",
  );
});

it("preserves provider authentication errors and hides unrecognized defects", () => {
  expect(
    formatEnvironmentQueryError(
      Cause.fail(new SandboxOperationError({ category: "authentication" })),
    ),
  ).toBe("Sandbox provider authentication failed.");
  expect(formatEnvironmentQueryError(Cause.die({ privateDetail: "not for display" }))).toBe(
    "The environment request failed.",
  );
});

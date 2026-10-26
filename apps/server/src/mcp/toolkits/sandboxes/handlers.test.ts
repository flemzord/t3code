import { expect, it } from "@effect/vitest";
import { EnvironmentId, SandboxOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as SandboxService from "../../../sandboxes/SandboxService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { SandboxToolkit } from "./tools.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "sandbox-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sandbox-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const decodeFailure = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String, message: Schema.String })),
);

it.effect.each(["read-only", "approval-required", "full-access"] as const)(
  "guards sandbox provisioning for a %s client before contacting the provider",
  (access) => {
    let calls = 0;
    const layer = McpHttpServer.toolkitRegistration(SandboxToolkit, Handlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(liveThreadsLayer),
      Layer.provide(
        Layer.mock(SandboxService.SandboxService)({
          create: () =>
            Effect.sync(() => {
              calls++;
            }).pipe(
              Effect.andThen(
                Effect.fail(new SandboxOperationError({ category: "authentication" })),
              ),
            ),
        }),
      ),
    );
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("controller"),
      requestNamespace: "client:sandbox-test",
      thread: undefined,
      client: { sessionId: "session", label: "sandbox-test", access },
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server.callTool({
        name: "t3_sandbox_create",
        arguments: {
          provider: "boat",
          requestId: "request-1",
          name: "Test",
          templateId: "clean",
          machineType: "small",
          ttlSeconds: 3600,
        },
      });
      const failure = yield* decodeFailure(
        result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      );
      expect(failure.code).toBe(
        access === "full-access" ? "orchestration_error" : "capability_denied",
      );
      expect(calls).toBe(access === "full-access" ? 1 : 0);
      if (access === "full-access")
        expect(failure.message).toBe("Sandbox provider authentication failed.");
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(layer),
      Effect.scoped,
    );
  },
);

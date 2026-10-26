import * as Schema from "effect/Schema";

export const NamespaceTemplate = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  version: Schema.NullOr(Schema.String),
  machineType: Schema.NullOr(Schema.Literals(["small", "default", "large", "xlarge"])),
  shape: Schema.NullOr(
    Schema.Struct({
      virtualCpu: Schema.Int,
      memoryMegabytes: Schema.Int,
      machineArch: Schema.String,
      os: Schema.String,
    }),
  ),
  machineTypeOverrideSupported: Schema.Literal(false),
  ttlOverrideSupported: Schema.Literal(false),
  ttlPolicy: Schema.Literal("provider_managed"),
});
export type NamespaceTemplate = typeof NamespaceTemplate.Type;

import { useState } from "react";
import type {
  EnvironmentId,
  NamespaceWorktreeSettings,
  SandboxMachineType,
} from "@t3tools/contracts";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import {
  namespaceWorktreeSetting,
  namespaceTemplateBlockReason,
  namespaceTemplateShape,
} from "./NamespaceWorktreeSetting.logic";
import { sandboxEnvironment } from "../../state/sandboxes";
import { useEnvironmentQuery } from "../../state/query";
import { useSettingsScope } from "./SettingsScopeContext";
import { usePrimaryEnvironmentId, useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";

const MACHINE_TYPES = ["small", "default", "large", "xlarge"] as const;

export function NamespaceWorktreeSetting() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["namespaceWorktrees"]);
  const policy = settings.namespaceWorktrees;
  const { targets, target } = useSettingsScope();
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentId =
    target?.environmentId === primary &&
    targets.every((candidate) => candidate.environmentId === primary) &&
    Boolean(window.desktopBridge) &&
    environments.some(
      (environment) =>
        environment.environmentId === primary &&
        environment.serverConfig?.namespaceWorktrees === true,
    )
      ? primary
      : null;
  return (
    <NamespaceWorktreeFields
      key={JSON.stringify(policy)}
      policy={policy}
      environmentId={environmentId}
      mixed={mixed}
      save={(value) => update({ namespaceWorktrees: value })}
    />
  );
}

function NamespaceWorktreeFields({
  policy,
  environmentId,
  mixed,
  save,
}: {
  policy: NamespaceWorktreeSettings | null;
  environmentId: EnvironmentId | null;
  mixed: boolean;
  save: (value: NamespaceWorktreeSettings | null) => void;
}) {
  const [image, setImage] = useState(policy?.image ?? "");
  const [machineType, setMachineType] = useState<SandboxMachineType>(
    policy?.machineType ?? "default",
  );
  const templates = useNamespaceTemplates(environmentId);
  const persist = (enabled: boolean, type = machineType, nextImage = image) => {
    try {
      const normalizedImage = nextImage.trim();
      const reason = enabled ? namespaceTemplateBlockReason(normalizedImage, templates.data) : null;
      const template = templates.data?.find(
        (candidate) => `blueprint:${candidate.id}` === normalizedImage,
      );
      if (reason) throw new Error(reason);
      if (enabled && environmentId === null)
        throw new Error("Select T3 Desktop's local controller to configure Namespace worktrees.");
      save(
        enabled ? namespaceWorktreeSetting(normalizedImage, template?.machineType ?? type) : null,
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Namespace setting not saved",
        description: error instanceof Error ? error.message : "Invalid Namespace image.",
      });
    }
  };
  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["namespaceWorktrees"]}
        mixed={mixed}
        title="Namespace worktrees"
        description="Create a new billed Namespace VM for every new worktree on its first send. Requires T3 Desktop's local controller. Use an image with your tools and provider authentication already configured."
        control={
          <Switch
            aria-label="Namespace worktrees"
            checked={!mixed && policy !== null}
            mixed={mixed}
            onCheckedChange={(enabled) => persist(enabled)}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["namespaceWorktrees"]}
        title="Namespace image or template"
      >
        {environmentId === null ? (
          <p className="pb-2 text-xs text-muted-foreground">
            Select T3 Desktop's local controller to load Namespace templates.
          </p>
        ) : null}
        <NamespaceTemplateFields
          environmentId={environmentId}
          query={templates}
          image={image}
          machineType={machineType}
          onChange={(nextImage, type) => {
            setImage(nextImage);
            setMachineType(type);
          }}
        />
        {policy ? (
          <Button size="sm" variant="outline" onClick={() => persist(true)}>
            Save Namespace settings
          </Button>
        ) : null}
      </SettingsRow>
    </>
  );
}

export function useNamespaceTemplates(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : sandboxEnvironment.templates({ environmentId, input: {} }),
  );
}

export function NamespaceTemplateFields({
  environmentId,
  query,
  image,
  machineType,
  onChange,
}: {
  environmentId: EnvironmentId | null;
  query: ReturnType<typeof useNamespaceTemplates>;
  image: string;
  machineType: SandboxMachineType;
  onChange: (image: string, machineType: SandboxMachineType) => void;
}) {
  const [mode, setMode] = useState(image && !image.startsWith("blueprint:") ? "image" : "template");
  const selected = query.data?.find((template) => `blueprint:${template.id}` === image);
  const reason = namespaceTemplateBlockReason(image, query.data);
  return (
    <div className="space-y-3 pb-3">
      <Select
        value={mode}
        onValueChange={(value) => {
          if (value === "image" || value === "template") {
            setMode(value);
            onChange("", machineType);
          }
        }}
      >
        <SelectTrigger size="sm" aria-label="Namespace source">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="template">Saved template</SelectItem>
          <SelectItem value="image">Image reference</SelectItem>
        </SelectPopup>
      </Select>
      {mode === "template" ? (
        <>
          <div className="flex items-center gap-2">
            <Select
              value={selected?.id ?? null}
              onValueChange={(id) => {
                const template = query.data?.find((candidate) => candidate.id === id);
                if (
                  template?.machineType &&
                  !namespaceTemplateBlockReason(`blueprint:${template.id}`, query.data)
                )
                  onChange(`blueprint:${template.id}`, template.machineType);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Namespace template"
                disabled={environmentId === null || query.isPending}
              >
                <SelectValue
                  placeholder={query.isPending ? "Loading templates…" : "Choose a template"}
                />
              </SelectTrigger>
              <SelectPopup>
                {query.data?.map((template) => (
                  <SelectItem
                    key={template.id}
                    value={template.id}
                    disabled={
                      namespaceTemplateBlockReason(`blueprint:${template.id}`, query.data) !== null
                    }
                  >
                    {template.name}
                    {template.version ? ` (${template.version})` : ""}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={environmentId === null || query.isPending}
              onClick={query.refresh}
            >
              {query.isPending ? "Loading…" : "Refresh templates"}
            </Button>
          </div>
          {query.error ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {query.error}
            </p>
          ) : query.isSuccess && query.data?.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No saved Namespace templates. Choose an image reference instead.
            </p>
          ) : null}
          {selected ? (
            <p className="text-xs text-muted-foreground">{namespaceTemplateShape(selected)}</p>
          ) : null}
          {reason ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {reason}
            </p>
          ) : null}
        </>
      ) : (
        <Input
          aria-label="Namespace image"
          value={image}
          onChange={(event) => onChange(event.target.value, machineType)}
          placeholder="builtin:… or an image reference"
          maxLength={255}
        />
      )}
      <Select
        value={machineType}
        disabled={mode === "template" || image.startsWith("blueprint:")}
        onValueChange={(value) => {
          const type = MACHINE_TYPES.find((candidate) => candidate === value);
          if (type) onChange(image, type);
        }}
      >
        <SelectTrigger size="sm" aria-label="Namespace machine type">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {MACHINE_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

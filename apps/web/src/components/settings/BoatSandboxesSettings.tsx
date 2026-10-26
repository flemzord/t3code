import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ManagedSandbox,
  type SandboxCreateInput,
  SandboxOperationError,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { useState } from "react";

import { connectPairing, connectSshEnvironment } from "~/connection/onboarding";
import { requestConfirmDialog } from "~/confirmDialog";
import { randomUUID } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { sandboxCreateAttemptAtom, sandboxEnvironment } from "~/state/sandboxes";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  parseSandboxCreateDraft,
  unconfirmedSandboxCreate,
  sandboxOperationErrorMessage,
  sandboxCreateWasRejected,
} from "./BoatSandboxesSettings.logic";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };
const PROVIDERS = [
  { value: "boat", label: "Boat" },
  { value: "namespace", label: "Namespace" },
] as const;
const MACHINE_TYPES = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "xlarge", label: "Extra large" },
] as const;
const NAMESPACE_MACHINE_TYPES = [
  { value: "small", label: "Small · 4 CPU / 8 GiB" },
  { value: "default", label: "Default · 8 CPU / 16 GiB" },
  { value: "large", label: "Large · 16 CPU / 32 GiB" },
  { value: "xlarge", label: "Extra large · 32 CPU / 64 GiB" },
] as const;

export function BoatSandboxesSettings({
  environments,
  primaryEnvironmentId,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const controllers = environments.filter(
    (environment) =>
      environment.entry.enabled &&
      environment.connection.phase === "connected" &&
      environment.serverConfig?.managedSandboxes === true,
  );
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const [provider, setProvider] = useState<SandboxCreateInput["provider"]>("boat");
  const controller =
    selectedId === null
      ? (controllers.find((environment) => environment.environmentId === primaryEnvironmentId) ??
        controllers[0])
      : controllers.find((environment) => environment.environmentId === selectedId);

  if (controllers.length === 0) return null;

  const items = controllers.map((environment) => ({
    value: environment.environmentId,
    label: environment.label,
  }));
  return (
    <SettingsSection {...searchableSetting("managed-sandboxes")}>
      <SettingsRow
        title="Controller environment"
        description="This environment stores your sandbox provider credentials and manages the machines. It can be local or remote."
        control={
          <Select
            items={items}
            value={controller?.environmentId ?? null}
            onValueChange={setSelectedId}
          >
            <SelectTrigger size="sm" aria-label="Sandbox controller environment">
              <SelectValue placeholder="Select a connected environment" />
            </SelectTrigger>
            <SelectPopup>
              {items.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Sandbox provider"
        description="Provider credentials are separate. Choose which provider to configure and use for new machines."
        control={
          <Select
            items={PROVIDERS}
            value={provider}
            onValueChange={(value) => {
              if (value !== null) setProvider(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Sandbox provider">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {PROVIDERS.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {controller ? (
        <BoatEnvironmentSettings
          key={`${controller.environmentId}:${provider}`}
          environmentId={controller.environmentId}
          provider={provider}
          namespaceConnectAvailable={
            Boolean(window.desktopBridge) && controller.environmentId === primaryEnvironmentId
          }
        />
      ) : (
        <SettingsRow title="Reconnect the selected controller, or select another environment." />
      )}
    </SettingsSection>
  );
}

function BoatEnvironmentSettings({
  environmentId,
  provider,
  namespaceConnectAvailable,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: SandboxCreateInput["provider"];
  readonly namespaceConnectAvailable: boolean;
}) {
  const canConfigure = useAtomValue(sandboxEnvironment.configure.permissionAtom(environmentId));
  const canCreate = useAtomValue(sandboxEnvironment.create.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    canConfigure ? sandboxEnvironment.list({ environmentId, input: {} }) : null,
  );
  const configure = useAtomCommand(sandboxEnvironment.configure, COMMAND_OPTIONS);
  const create = useAtomCommand(sandboxEnvironment.create, COMMAND_OPTIONS);
  const [attempt, setAttempt] = useAtom(sandboxCreateAttemptAtom(environmentId, provider));
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [machineType, setMachineType] = useState<SandboxCreateInput["machineType"]>("default");
  const [ttlHours, setTtlHours] = useState("24");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unresolvedAttempt = unconfirmedSandboxCreate(attempt, query.data?.sandboxes ?? null);
  const providerLabel = provider === "boat" ? "Boat" : "Namespace";
  const credentialLabel = provider === "boat" ? "Boat API key" : "Namespace API token";
  const configured =
    query.data?.providers.some((entry) => entry.provider === provider && entry.configured) === true;

  const handleConfigure = async () => {
    if (!canConfigure || busy || !apiKey.trim()) return;
    const key = apiKey.trim();
    setApiKey("");
    setBusy(true);
    setError(null);
    const result = await configure({ environmentId, input: { provider, apiKey: key } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(sandboxOperationErrorMessage(squashAtomCommandFailure(result)));
    }
    query.refresh();
    setBusy(false);
  };

  const handleDisconnect = async () => {
    if (!canConfigure || busy || !configured) return;
    setBusy(true);
    setError(null);
    const confirmed = await requestConfirmDialog(
      `Remove the ${credentialLabel} from this controller? Machines and their saved history remain. Reconnect the provider to manage them.`,
      { variant: "destructive" },
    );
    if (!confirmed) {
      setBusy(false);
      return;
    }
    setApiKey("");
    const result = await configure({ environmentId, input: { provider, apiKey: "" } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setError(sandboxOperationErrorMessage(squashAtomCommandFailure(result)));
    query.refresh();
    setBusy(false);
  };

  const submitCreate = async (input: SandboxCreateInput) => {
    if (!canCreate || busy) return;
    setAttempt(input);
    setBusy(true);
    setError(null);
    const result = await create({ environmentId, input });
    if (result._tag === "Success") {
      setAttempt(null);
      setName("");
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      if (sandboxCreateWasRejected(failure)) {
        setAttempt(null);
        setName(input.name);
        setTemplateId(input.templateId);
        setMachineType(input.machineType);
        setTtlHours(String(input.ttlSeconds / 3600));
      }
      setError(sandboxOperationErrorMessage(failure));
    }
    query.refresh();
    setBusy(false);
  };

  const handleCreate = async () => {
    if (unresolvedAttempt) return submitCreate(unresolvedAttempt);
    const decoded = parseSandboxCreateDraft({
      requestId: randomUUID(),
      provider,
      name,
      templateId,
      machineType,
      ttlHours,
    });
    if (Option.isNone(decoded)) {
      setError(
        provider === "namespace"
          ? "Enter a display name and a valid clean image name or OCI reference."
          : "Enter a name, a valid clean template ID, and a TTL between 1 and 720 hours.",
      );
      return;
    }
    await submitCreate(decoded.value);
  };

  if (!canConfigure) {
    return (
      <SettingsRow
        title="Sandbox management is unavailable"
        description="This connection needs environment:maintain permission to view or manage sandboxes."
      />
    );
  }

  return (
    <>
      <SettingsRow
        title={configured ? `${credentialLabel} configured` : `Configure ${providerLabel}`}
        description={`${provider === "namespace" ? "Use a Namespace API token with at least five minutes of validity. " : ""}Credentials are saved only on the controller environment. Disconnect provider removes them and keeps machine records. Stop or delete machines first to avoid ongoing charges.`}
      >
        <form
          className="flex flex-wrap items-center gap-2 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            void handleConfigure();
          }}
        >
          <div className="min-w-0 flex-1 basis-40">
            <Input
              type="password"
              autoComplete="new-password"
              aria-label={credentialLabel}
              placeholder={credentialLabel}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={busy}
              spellCheck={false}
              maxLength={4096}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !apiKey.trim()}>
            {provider === "boat" ? "Save key" : "Save token"}
          </Button>
          {configured ? (
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              Disconnect provider
            </Button>
          ) : null}
        </form>
      </SettingsRow>
      {error || query.error ? (
        <div role="alert" className="px-3 py-2 text-xs text-destructive-foreground sm:px-4">
          {error ?? sandboxOperationErrorMessage(query.failure)}
        </div>
      ) : null}
      <SettingsRow
        title={`Create a ${providerLabel} sandbox`}
        description={`${provider === "boat" ? "Use a clean saved Boat template with your tools preinstalled." : "Use a clean Namespace image with Node.js 24+, npm, systemd and sudo. Accepts builtin:* images, image names and OCI references."} Do not include T3 userdata, provider sessions or connection credentials. Connect prepares an independent T3 service. Sign in to your chosen providers after connecting.`}
      >
        {provider === "namespace" ? (
          <p className="pb-3 text-xs text-muted-foreground">
            Namespace uses Linux amd64 machines in iad. Its plan controls expiration, up to three
            hours; this form does not set a custom deadline. To connect, use T3 Desktop's local
            controller with the official devbox CLI installed and run devbox login for the same
            account and tenant as the saved API token. Lifecycle actions work on any controller.
          </p>
        ) : null}
        {unresolvedAttempt ? (
          <div className="space-y-2 pb-3">
            <p className="text-xs text-muted-foreground">
              Creation of {unresolvedAttempt.name} has not been confirmed. Reload the saved
              machines, then retry the same request if needed. Its{" "}
              {provider === "boat" ? "template" : "image"}, machine type and duration stay
              unchanged.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || query.isPending}
                onClick={query.refresh}
              >
                Reload saved machines
              </Button>
              <Button
                size="sm"
                disabled={busy || !canCreate || !query.isSuccess || !configured}
                onClick={() => void submitCreate(unresolvedAttempt)}
              >
                {busy ? "Creating…" : "Retry same creation"}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-3 pb-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <fieldset
              disabled={busy || !canCreate || !query.isSuccess || !configured}
              className="space-y-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
                  <span>{provider === "namespace" ? "Display name (T3 only)" : "Name"}</span>
                  <Input
                    size="sm"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Development"
                    required
                    maxLength={120}
                  />
                </label>
                {provider === "namespace" ? (
                  <div className="space-y-1 text-xs">
                    <span>Duration policy</span>
                    <p className="text-muted-foreground">
                      Namespace applies your plan's runtime and idle limits. No custom stop deadline
                      is set.
                    </p>
                  </div>
                ) : (
                  <label className="space-y-1 text-xs">
                    <span>TTL (hours, maximum 720)</span>
                    <Input
                      size="sm"
                      type="number"
                      min={1}
                      max={720}
                      step={1}
                      required
                      value={ttlHours}
                      onChange={(event) => setTtlHours(event.target.value)}
                    />
                  </label>
                )}
                <div className="space-y-1 text-xs">
                  <span>Machine type</span>
                  <Select
                    items={provider === "boat" ? MACHINE_TYPES : NAMESPACE_MACHINE_TYPES}
                    value={machineType}
                    onValueChange={(value) => {
                      if (value !== null) setMachineType(value);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={`${providerLabel} machine type`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {(provider === "boat" ? MACHINE_TYPES : NAMESPACE_MACHINE_TYPES).map(
                        ({ value, label }) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectPopup>
                  </Select>
                </div>
                {provider === "namespace" ? (
                  <div className="space-y-1 text-xs">
                    <span>Duration policy</span>
                    <p className="text-muted-foreground">
                      Namespace applies your plan's runtime and idle limits. No custom stop deadline
                      is set.
                    </p>
                  </div>
                ) : (
                  <label className="space-y-1 text-xs">
                    <span>TTL (hours, maximum 720)</span>
                    <Input
                      size="sm"
                      type="number"
                      min={1}
                      max={720}
                      step={1}
                      required
                      value={ttlHours}
                      onChange={(event) => setTtlHours(event.target.value)}
                    />
                  </label>
                )}
              </div>
              <Button
                type="submit"
                size="sm"
                disabled={!name.trim() || !templateId.trim() || !ttlHours}
              >
                {busy ? "Creating…" : "Create sandbox"}
              </Button>
            </fieldset>
          </form>
        )}
      </SettingsRow>
      <SettingsRow
        title="Managed machines"
        description="Refresh a machine to reconcile its provider state. Connect prepares T3 when the machine is running. Deleted machines stay in this history."
        control={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={busy || query.isPending}
            onClick={query.refresh}
          >
            {query.isPending ? "Loading…" : "Reload list"}
          </Button>
        }
      />
      {query.data?.sandboxes.map((sandbox) => (
        <BoatSandboxRow
          key={sandbox.id}
          environmentId={environmentId}
          sandbox={sandbox}
          namespaceConnectAvailable={namespaceConnectAvailable}
          disabled={busy || !query.isSuccess}
          onChanged={query.refresh}
        />
      ))}
      {query.isSuccess && query.data?.sandboxes.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">No managed machines yet.</p>
      ) : null}
    </>
  );
}

function BoatSandboxRow({
  environmentId,
  sandbox,
  namespaceConnectAvailable,
  disabled,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly sandbox: ManagedSandbox;
  readonly namespaceConnectAvailable: boolean;
  readonly disabled: boolean;
  readonly onChanged: () => void;
}) {
  const canRefresh = useAtomValue(sandboxEnvironment.refresh.permissionAtom(environmentId));
  const canStop = useAtomValue(sandboxEnvironment.stop.permissionAtom(environmentId));
  const canResume = useAtomValue(sandboxEnvironment.resume.permissionAtom(environmentId));
  const canRemove = useAtomValue(sandboxEnvironment.remove.permissionAtom(environmentId));
  const canConnect = useAtomValue(sandboxEnvironment.connect.permissionAtom(environmentId));
  const refresh = useAtomCommand(sandboxEnvironment.refresh, COMMAND_OPTIONS);
  const stop = useAtomCommand(sandboxEnvironment.stop, COMMAND_OPTIONS);
  const resume = useAtomCommand(sandboxEnvironment.resume, COMMAND_OPTIONS);
  const remove = useAtomCommand(sandboxEnvironment.remove, COMMAND_OPTIONS);
  const connect = useAtomCommand(sandboxEnvironment.connect, COMMAND_OPTIONS);
  const pair = useAtomCommand(connectPairing, COMMAND_OPTIONS);
  const connectSsh = useAtomCommand(connectSshEnvironment, COMMAND_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const connectAvailable = sandbox.provider !== "namespace" || namespaceConnectAvailable;

  const runAction = async (action: "refresh" | "stop" | "resume" | "remove" | "connect") => {
    if (busy || disabled) return;
    if (action === "connect" && !connectAvailable) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    if (action === "stop" || action === "remove") {
      const message =
        action === "remove"
          ? `Permanently delete ${sandbox.name}? This permanently deletes its files and T3 history and disconnects any running agents. The controller keeps a deletion record.`
          : `Stop ${sandbox.name}? This disconnects any agents running on this machine. You can resume it later.`;
      const confirmed = await requestConfirmDialog(message, { variant: "destructive" });
      if (!confirmed) {
        setBusy(false);
        return;
      }
    }
    const target = { environmentId, input: { id: sandbox.id } };
    const result =
      action === "connect"
        ? await connect(target)
        : action === "refresh"
          ? await refresh(target)
          : action === "stop"
            ? await stop(target)
            : action === "resume"
              ? await resume(target)
              : await remove(target);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(sandboxOperationErrorMessage(squashAtomCommandFailure(result)));
    } else if (result._tag === "Success" && action === "connect" && "type" in result.value) {
      const paired =
        result.value.type === "pairing"
          ? await pair({ pairingUrl: result.value.url })
          : await connectSsh({ target: result.value.target });
      if (paired._tag === "Failure") {
        if (!isAtomCommandInterrupted(paired))
          setError(
            "T3 could not connect to this sandbox. Refresh the machine, then try Connect again.",
          );
      } else {
        toastManager.add({
          type: "success",
          title: "Sandbox connected",
          description: "Create projects and worktrees on this environment as usual.",
        });
      }
    } else if (result._tag === "Success" && action !== "refresh") {
      setNotice("Request accepted. Refresh this machine to see its latest state.");
    }
    onChanged();
    setBusy(false);
  };

  return (
    <SettingsRow
      title={sandbox.name}
      description={`${sandbox.provider === "boat" ? "Boat" : "Namespace"} · ${sandbox.state} · ${sandbox.machineType} · ${sandbox.templateId} · ${sandbox.provider === "namespace" ? "provider plan runtime and idle limits" : `TTL ${sandbox.ttlSeconds / 3600} h`}`}
      status={
        sandbox.state === "deleted"
          ? "Deleted · history retained on the controller"
          : `T3 connection: ${sandbox.connectionState}`
      }
    >
      {sandbox.lastError ? (
        <p className="pb-2 text-xs text-destructive-foreground">
          {new SandboxOperationError({ category: sandbox.lastError.category }).message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="pb-2 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="pb-2 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {sandbox.provider === "namespace" && sandbox.state === "running" ? (
        <p className="pb-2 text-xs text-muted-foreground">
          Namespace Connect requires T3 Desktop's local controller, the official devbox CLI, and
          devbox login for the same account and tenant as the saved API token.
          {!namespaceConnectAvailable
            ? " This controller cannot open Namespace connections; lifecycle actions remain available here."
            : ""}
        </p>
      ) : null}
      {sandbox.state !== "deleted" ? (
        <div className="flex flex-wrap gap-1.5 pb-3">
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || busy || !canRefresh}
            onClick={() => void runAction("refresh")}
          >
            {busy ? "Working…" : "Refresh"}
          </Button>
          {sandbox.state === "running" ? (
            <Button
              size="xs"
              disabled={disabled || busy || !canConnect || !connectAvailable}
              onClick={() => void runAction("connect")}
            >
              Connect
            </Button>
          ) : null}
          {["requested", "provisioning", "running", "resuming", "unknown"].includes(
            sandbox.state,
          ) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || busy || !canStop}
              onClick={() => void runAction("stop")}
            >
              Stop
            </Button>
          ) : null}
          {sandbox.state === "stopped" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || busy || !canResume}
              onClick={() => void runAction("resume")}
            >
              Resume
            </Button>
          ) : null}
          {sandbox.state !== "deleting" ? (
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={disabled || busy || !canRemove}
              onClick={() => void runAction("remove")}
            >
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}
    </SettingsRow>
  );
}

import type { ConfigOption, ProviderView, StartOptions } from "@kirochrome/shared";

/**
 * Model, mode and the rest, chosen before a session exists.
 *
 * The list comes from the provider's last setup check, which ran `session/new`
 * and kept what the agent advertised. It can lag what the agent offers today
 * — a value the agent no longer knows is skipped when the session starts, not
 * refused here. The opening message is for settings an agent exposes only as
 * a slash command (Kiro's `/effort`): it goes as the first turn.
 */
export function StartPickers({
  provider,
  value,
  onChange,
  compact = false,
}: {
  provider: ProviderView | undefined;
  value: StartOptions;
  onChange: (next: StartOptions) => void;
  compact?: boolean;
}) {
  const options = provider?.lastCheck?.options ?? [];
  const values = value.configValues ?? {};
  // A check from before the list was kept has nothing to offer; say so
  // rather than showing an empty row.
  const stale = provider?.lastCheck?.status === "ok" && provider.lastCheck.options === undefined;
  const set = (id: string, v: string | boolean) => onChange({ ...value, configValues: { ...values, [id]: v } });

  return (
    <div className={`start-pickers ${compact ? "compact" : ""}`}>
      {stale && <span className="start-stale">Re-run this provider&rsquo;s check on Setup to choose a model here.</span>}
      {options.map((option) => (
        <label className="start-picker" key={option.id} title={option.description}>
          <span className="start-picker-label">{option.name}</span>
          <Picker option={option} value={values[option.id]} onChange={(v) => set(option.id, v)} />
        </label>
      ))}
      <label className="start-picker" title="Sent as the first message — a slash command such as /effort high">
        <span className="start-picker-label">Opening</span>
        <input
          value={value.opening ?? ""}
          onChange={(e) => onChange({ ...value, opening: e.target.value })}
          placeholder="/effort high"
          spellCheck={false}
        />
      </label>
    </div>
  );
}

function Picker({
  option,
  value,
  onChange,
}: {
  option: ConfigOption;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
}) {
  if (option.type === "boolean") {
    return <input type="checkbox" checked={Boolean(value ?? option.currentValue)} onChange={(e) => onChange(e.target.checked)} />;
  }
  return (
    <select value={String(value ?? option.currentValue)} onChange={(e) => onChange(e.target.value)}>
      {option.options?.map((o) => (
        <option key={o.value} value={o.value} title={o.description}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

/** Only the values the user actually changed from the check's defaults. */
export function chosen(provider: ProviderView | undefined, start: StartOptions): StartOptions {
  const options = provider?.lastCheck?.options ?? [];
  const configValues: Record<string, string | boolean> = {};
  for (const [id, v] of Object.entries(start.configValues ?? {})) {
    const option = options.find((o) => o.id === id);
    if (option && v !== option.currentValue) configValues[id] = v;
  }
  const opening = start.opening?.trim();
  return {
    ...(Object.keys(configValues).length ? { configValues } : {}),
    ...(opening ? { opening } : {}),
  };
}

import { useEffect, useState } from "react";
import { fetchConfig } from "./api.ts";
import type { ProviderConfig, ThinkingLevel } from "../types.ts";

/**
 * The derived model catalog every picker needs: the subscriptions plus the
 * per-subscription thinking levels and context windows the server derives
 * from Pi's catalog. Composer and SessionView share this one projection.
 */
export interface ModelCatalog {
  providers: ProviderConfig[];
  /** The subscription new sessions default to ("" when none is configured). */
  defaultProviderId: string;
  /** Thinking levels each subscription's model supports (server-derived). */
  capabilities: Record<string, ThinkingLevel[]>;
  /** Context window per subscription's model, for the token meter. */
  contextWindows: Record<string, number>;
}

const EMPTY: ModelCatalog = { providers: [], defaultProviderId: "", capabilities: {}, contextWindows: {} };

export function useModelCatalog(): ModelCatalog {
  const [catalog, setCatalog] = useState<ModelCatalog>(EMPTY);
  useEffect(() => {
    void fetchConfig()
      .then((cfg) =>
        setCatalog({
          providers: cfg.providers,
          defaultProviderId: cfg.defaultProviderId ?? "",
          capabilities: cfg.modelCapabilities ?? {},
          contextWindows: cfg.modelContextWindows ?? {},
        }),
      )
      .catch(() => {
        // A failed catalog fetch leaves the pickers empty rather than broken;
        // the composer still works with the server-side default subscription.
      });
  }, []);
  return catalog;
}

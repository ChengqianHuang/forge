/**
 * Task-outcome notification.
 *
 * Scope: a finished session is already reported in place — timeline notices,
 * the timeline and sidebar status dot update on their own.
 * So there is deliberately no in-app toast host here; a floating toast would
 * only restate what is on screen. This module covers the one case the
 * conversation view cannot: the window is hidden and the user would otherwise
 * never learn the outcome.
 *
 * Transport: the Tauri notification plugin (the Web Notification API is
 * unavailable inside the webview), falling back to Web Notification in browser
 * dev. Delivery is best-effort — a missing permission is not an error.
 */

export type TaskOutcome = "completed" | "failed" | "cancelled";

/**
 * Map a session-terminal event to the outcome it reports.
 *
 * The server emits exactly two terminal types (src/server/session-manager.ts):
 * SESSION_FAILED for a failed run and SESSION_ENDED for everything else. A
 * cancelled run therefore arrives as SESSION_ENDED carrying
 * `payload.status = "cancelled"` — `status` is the authoritative field, the
 * event type only distinguishes failure.
 */
export function outcomeFromTerminal(type: string, status: unknown): TaskOutcome {
  if (status === "completed" || status === "failed" || status === "cancelled") return status;
  return type === "SESSION_FAILED" ? "failed" : "completed";
}

export function notifyTaskOutcome(goal: string, outcome: TaskOutcome): void {
  const title =
    outcome === "completed"
      ? "Task completed"
      : outcome === "cancelled"
        ? "Task cancelled"
        : "Task failed";
  const trimmed = goal.trim();
  const body = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  void systemNotify(title, body || title);
}

async function systemNotify(title: string, body: string): Promise<void> {
  try {
    const w = window as { __TAURI_INTERNALS__?: unknown };
    if (w.__TAURI_INTERNALS__) {
      const plugin = await import("@tauri-apps/plugin-notification");
      let granted = await plugin.isPermissionGranted();
      if (!granted) granted = (await plugin.requestPermission()) === "granted";
      if (granted) plugin.sendNotification({ title, body });
      return;
    }
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "granted") {
        new Notification(title, { body });
      } else if (Notification.permission === "default") {
        // Browser dev: ask once; takes effect from the next task onward.
        void Notification.requestPermission();
      }
    }
  } catch {
    // Notifications are best-effort; never surface errors for them.
  }
}

// Shared WebSocket message contract between renderer and Python backend.
// NOTE: The Python equivalents live in backend/models.py and are NOT
// linked to this union by the type system — renames here will not
// propagate to Python.

export interface UserMessage {
  type: "user_message";
  payload: { text: string };
}

export interface GetSettings {
  type: "get_settings";
}

export interface SettingsResponse {
  type: "settings_response";
  payload: { theme: "light" | "dark"; model: string };
}

export interface ScreenshotSaved {
  type: "screenshot_saved";
  payload: { path: string };
}

export type WsMessage =
  | UserMessage
  | GetSettings
  | SettingsResponse
  | ScreenshotSaved;

// Surface exposed by preload.ts via contextBridge.exposeInMainWorld.
// Static tooling will not connect the two sides — the only evidence
// is the string literal "quickwork".
export interface QuickworkBridge {
  takeScreenshot: () => Promise<string>;
  saveFile: (content: string) => Promise<void>;
}

declare global {
  interface Window {
    quickwork: QuickworkBridge;
  }
}

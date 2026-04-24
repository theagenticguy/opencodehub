import type { GetSettings, SettingsResponse, WsMessage } from "../../shared/types.js";

let socket: WebSocket | null = null;

function ensureSocket(): WebSocket {
  if (socket && socket.readyState === WebSocket.OPEN) return socket;
  socket = new WebSocket("ws://localhost:8765");
  return socket;
}

export function fetchSettings(): Promise<SettingsResponse["payload"]> {
  const msg: GetSettings = { type: "get_settings" };
  const raw = JSON.stringify(msg satisfies WsMessage);
  const ws = ensureSocket();
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent<string>) => {
      const parsed = JSON.parse(event.data) as WsMessage;
      if (parsed.type === "settings_response") {
        ws.removeEventListener("message", onMessage);
        resolve(parsed.payload);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(raw);
  });
}

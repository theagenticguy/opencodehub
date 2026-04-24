import type { UserMessage, WsMessage } from "../../shared/types.js";

interface ChatState {
  messages: Map<string, string>;
  send: (text: string) => void;
}

let socket: WebSocket | null = null;

function ensureSocket(): WebSocket {
  if (socket && socket.readyState === WebSocket.OPEN) return socket;
  socket = new WebSocket("ws://localhost:8765");
  return socket;
}

export function sendMessage(text: string): void {
  const msg: UserMessage = { type: "user_message", payload: { text } };
  const raw = JSON.stringify(msg satisfies WsMessage);
  ensureSocket().send(raw);
}

export function useChatStore(): ChatState {
  const messages = new Map<string, string>();
  return {
    messages,
    send: sendMessage,
  };
}

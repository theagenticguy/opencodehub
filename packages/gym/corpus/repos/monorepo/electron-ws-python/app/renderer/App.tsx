import { useEffect, useState } from "react";
import { sendMessage, useChatStore } from "./stores/chatStore.js";
import { fetchSettings } from "./stores/settingsStore.js";

export default function App(): JSX.Element {
  const chat = useChatStore();
  const [draft, setDraft] = useState("");
  const [theme, setTheme] = useState<string>("light");

  useEffect(() => {
    fetchSettings().then((s) => setTheme(s.theme));
  }, []);

  const onSend = () => {
    if (!draft) return;
    chat.send(draft);
    setDraft("");
  };

  const onScreenshot = async () => {
    const path = await window.quickwork.takeScreenshot();
    await window.quickwork.saveFile(`screenshot: ${path}`);
  };

  return (
    <div data-theme={theme}>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={onSend}>send</button>
      <button onClick={onScreenshot}>screenshot</button>
    </div>
  );
}

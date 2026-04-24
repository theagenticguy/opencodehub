import { contextBridge, ipcRenderer } from "electron";
import type { QuickworkBridge } from "../shared/types.js";

const bridge: QuickworkBridge = {
  takeScreenshot: () => ipcRenderer.invoke("take-screenshot") as Promise<string>,
  saveFile: (content: string) =>
    ipcRenderer.invoke("save-file", content) as Promise<void>,
};

// The string "quickwork" is the ONLY static link between renderer and
// main — window.quickwork.takeScreenshot() in App.tsx resolves at runtime.
contextBridge.exposeInMainWorld("quickwork", bridge);

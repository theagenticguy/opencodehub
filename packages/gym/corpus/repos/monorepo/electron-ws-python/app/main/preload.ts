import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../shared/types.js";

const bridge: DesktopBridge = {
  takeScreenshot: () => ipcRenderer.invoke("take-screenshot") as Promise<string>,
  saveFile: (content: string) =>
    ipcRenderer.invoke("save-file", content) as Promise<void>,
};

// The string "desktop" is the ONLY static link between renderer and
// main — window.desktop.takeScreenshot() in App.tsx resolves at runtime.
contextBridge.exposeInMainWorld("desktop", bridge);

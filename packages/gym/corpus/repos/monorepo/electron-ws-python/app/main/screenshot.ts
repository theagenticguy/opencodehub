import { ipcMain, desktopCapturer } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export function registerScreenshotHandler(): void {
  ipcMain.handle("take-screenshot", async (): Promise<string> => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    const primary = sources[0];
    if (!primary) throw new Error("no screen source available");
    const outPath = path.join(os.tmpdir(), `shot-${Date.now()}.png`);
    const png = primary.thumbnail.toPNG();
    await fs.writeFile(outPath, png);
    return outPath;
  });

  ipcMain.handle("save-file", async (_event, content: string): Promise<void> => {
    const outPath = path.join(os.tmpdir(), `note-${Date.now()}.txt`);
    await fs.writeFile(outPath, content, "utf8");
  });
}

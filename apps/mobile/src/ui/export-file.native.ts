import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import type { ExportFile } from "./screens/TeamDashboardScreen.js";

export async function saveExportFile({ filename, content }: ExportFile) {
  if (!(await isAvailableAsync())) throw new Error("File sharing is unavailable");
  const directory = new Directory(Paths.cache, "sports-motion-export");
  directory.create({ idempotent: true });
  const file = new File(directory, filename);
  file.create({ overwrite: true });
  try {
    file.write(content);
    await shareAsync(file.uri, { dialogTitle: filename, mimeType: "text/plain" });
  } finally {
    file.delete();
  }
}

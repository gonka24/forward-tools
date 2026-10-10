import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
/** Keep the prior submission hash readable if a later receipt update fails. */
export async function updateReceipt(path: string, value: unknown) {
  const temporary = path + ".tmp-" + randomUUID(),
    file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  // The receipt must survive a crash right after submission: persist the rename
  // itself where the platform allows syncing a directory (not on Windows).
  try {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {}
}

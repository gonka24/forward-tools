import { open, rename } from "node:fs/promises";
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
}

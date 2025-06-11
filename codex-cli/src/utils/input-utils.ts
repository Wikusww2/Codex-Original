import type { ResponseInputItem } from "openai/resources/responses/responses";
export type { ResponseInputItem };

import { fileTypeFromBuffer } from "file-type";
import fs from "fs/promises";
import path from "path";

export async function createInputItem(
  text: string,
  images: Array<string>,
): Promise<ResponseInputItem.Message> {
  const inputItem: ResponseInputItem.Message = {
    role: "user",
    content: [{ type: "text", text }] as any,
    type: "message",
  };

  for (const filePath of images) {
    try {
      /* eslint-disable no-await-in-loop */
      const binary = await fs.readFile(filePath);
      const kind = await fileTypeFromBuffer(binary);
      /* eslint-enable no-await-in-loop */
      const encoded = binary.toString("base64");
      const mime = kind?.mime ?? "application/octet-stream";
      inputItem.content.push({
        type: "input_image",
        detail: "auto",
        image_url: `data:${mime};base64,${encoded}`,
      });
    } catch (err) {
      inputItem.content.push({
        type: "text",
        text: `[missing image: ${path.basename(filePath)}]`,
      } as any);
    }
  }

  return inputItem;
}

import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { materializeWakeMedia } from "../src/runtime/media-materializer.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket } from "./fixtures/wake-packets.js";

describe("wake image materialization", () => {
  it("downloads an authenticated image to a turn-scoped file and removes it on cleanup", async () => {
    const raw = structuredClone(dmWakePacket) as any;
    raw.wake.event.payload.message.attachments = [{
      id: "media-1",
      kind: "image",
      content_type: "image/webp",
      width: 20,
      height: 10,
      url: "/v1/media/media-1/content",
    }];
    const result = await materializeWakeMedia(parseWakePacket(raw), {
      imageInputs: "local-file",
      downloadMedia: async (id) => {
        expect(id).toBe("media-1");
        return { bytes: Buffer.from("fake-webp"), contentType: "image/webp" };
      },
    });
    const attachment = (result.packet.wake.event!.payload!.message as any).attachments[0];
    expect(attachment.local_path).toMatch(/mingle-media-.*media-1\.webp$/);
    expect(attachment.availability).toBe("local-file");
    await expect(access(attachment.local_path)).resolves.toBeUndefined();
    await result.cleanup();
    await expect(access(attachment.local_path)).rejects.toThrow();
  });

  it("labels images honestly when a driver cannot inspect local files", async () => {
    const raw = structuredClone(dmWakePacket) as any;
    raw.wake.event.payload.message.attachments = [{ id: "media-2", kind: "image" }];
    const result = await materializeWakeMedia(parseWakePacket(raw), { imageInputs: "unsupported" });
    const attachment = (result.packet.wake.event!.payload!.message as any).attachments[0];
    expect(attachment).toMatchObject({ id: "media-2", availability: "unsupported" });
    expect(attachment.local_path).toBeUndefined();
  });
});

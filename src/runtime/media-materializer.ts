import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WakePacket } from "../protocol/wake-packet.js";

type DownloadMedia = (mediaId: string) => Promise<{ bytes: Buffer; contentType: string }>;
type MaterializeOptions = {
  imageInputs: "local-file" | "unsupported";
  downloadMedia?: DownloadMedia;
};
type PacketAttachment = Record<string, unknown> & { id?: unknown; kind?: unknown };

/** Download authenticated images for exactly one provider turn. The provider
 * sees only a temporary local path, never the Mingle key or storage URL. */
export async function materializeWakeMedia(packet: WakePacket, options: MaterializeOptions) {
  const message = packet.wake.event?.payload?.message;
  if (!message || typeof message !== "object") return { packet, cleanup: async () => {} };
  const attachments = (message as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return { packet, cleanup: async () => {} };
  const hasImages = attachments.some(
    (item) => Boolean(item && typeof item === "object" && (item as PacketAttachment).kind === "image"),
  );
  if (!hasImages) return { packet, cleanup: async () => {} };

  const next = structuredClone(packet);
  const nextMessage = next.wake.event!.payload!.message as { attachments: PacketAttachment[] };
  if (options.imageInputs === "unsupported") {
    nextMessage.attachments = nextMessage.attachments.map((item) =>
      item.kind === "image" ? { ...item, availability: "unsupported" } : item,
    );
    return { packet: next, cleanup: async () => {} };
  }
  if (!options.downloadMedia) throw new Error("image download unavailable for local-file driver");

  const directory = await mkdtemp(join(tmpdir(), "mingle-media-"));
  try {
    for (const item of nextMessage.attachments.slice(0, 4)) {
      if (item.kind !== "image" || typeof item.id !== "string") continue;
      const downloaded = await options.downloadMedia(item.id);
      if (!downloaded.contentType.startsWith("image/") || downloaded.bytes.byteLength > 10 * 1024 * 1024) {
        throw new Error(`invalid downloaded image ${item.id}`);
      }
      const path = join(directory, `${safeId(item.id)}.webp`);
      await writeFile(path, downloaded.bytes, { mode: 0o600 });
      item.local_path = path;
      item.availability = "local-file";
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { packet: next, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function safeId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

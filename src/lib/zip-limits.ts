import type JSZip from "jszip";

/** Bound decompressed memory, including archives with deceptive size metadata. */
export function readZipEntry(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    stream.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      bytes += chunk.length;
      if (bytes > limit) {
        exceeded = true;
        stream.pause();
        chunks.length = 0;
        reject(Object.assign(new Error("백업의 압축 해제 크기가 허용 범위를 초과했습니다."), { status: 413 }));
      } else chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
  });
}

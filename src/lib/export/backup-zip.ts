import { Readable } from "node:stream";
import JSZip from "jszip";

/**
 * 프로젝트 백업 ZIP 만들기 — 최대 메모리를 줄이려고 한꺼번에 읽지 않는다.
 *   project.json: 책 정보를 먼저 쓰고, 장은 하나씩 읽어(loadChapter) 이어 쓴다.
 *   이미지: 차례가 오면 한 장씩 받는다(loadAsset). 이미 압축된 형식이라 다시 압축하지 않는다(STORE).
 * JSZip 스트림 생성(streamFiles)이 파일을 차례로 읽으므로 한 번에 장 하나·이미지 한 장만 메모리에 있다.
 * 복원(import)은 버전 기록이 있든 없든(section.versions 없음) 그대로 받는다.
 */
export const BACKUP_FORMAT = "bookk-writer-backup";

export type BackupSource = {
  /** chapters를 뺀 프로젝트 정보(glossary·tocReports·assets 포함) */
  head: Record<string, unknown>;
  chapterIds: string[];
  loadChapter: (id: string) => Promise<unknown | null>;
  /** 이미지: ZIP 안 경로와 받는 함수 (저장소에 파일이 없으면 null → 빈 항목으로 남는다) */
  assets: { name: string; load: () => Promise<Buffer | null> }[];
};

const lazy = (gen: () => AsyncGenerator<Buffer>) => Readable.from(gen(), { objectMode: false });

function projectJson(src: BackupSource) {
  return lazy(async function* () {
    const marker = "\u0000CHAPTERS\u0000";
    const head = JSON.stringify({ format: BACKUP_FORMAT, version: 1, project: { ...src.head, chapters: marker } });
    const [pre, post] = head.split(JSON.stringify(marker));
    yield Buffer.from(pre + "[", "utf8");
    let first = true;
    for (const id of src.chapterIds) {
      const c = await src.loadChapter(id);
      if (!c) continue;
      yield Buffer.from((first ? "" : ",") + JSON.stringify(c), "utf8");
      first = false;
    }
    yield Buffer.from("]" + post, "utf8");
  });
}

export async function buildBackupZip(src: BackupSource): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("project.json", projectJson(src));
  for (const a of src.assets) {
    zip.file(a.name, lazy(async function* () {
      const buf = await a.load();
      if (buf?.length) yield buf;
    }), { compression: "STORE" });
  }
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    zip
      .generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE" })
      .on("data", (c: Buffer) => chunks.push(c))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return Buffer.concat(chunks);
}

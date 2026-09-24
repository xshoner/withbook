import "server-only";
import { getObject, removeObjects } from "./storage";

export type Uploaded = { name: string; type: string; buffer: Buffer };

/**
 * 업로드 파일 읽기 — 작은 파일은 요청에 바로 실려 오고(field),
 * 큰 파일은 브라우저가 incoming 버킷에 먼저 올린 뒤 경로만 보낸다(fieldPath + fieldName).
 */
export async function readUploads(form: FormData, field: string, maxBytes: number): Promise<Uploaded[]> {
  const out: Uploaded[] = [];
  for (const f of form.getAll(field)) {
    if (!(f instanceof File)) continue;
    if (f.size > maxBytes) throw Object.assign(new Error(`${f.name}: 파일이 너무 큽니다.`), { status: 413 });
    out.push({ name: f.name, type: f.type, buffer: Buffer.from(await f.arrayBuffer()) });
  }
  const paths = form.getAll(`${field}Path`).map(String);
  const names = form.getAll(`${field}Name`).map(String);
  for (const [i, p] of paths.entries()) {
    if (!/^u\/[a-f0-9-]{36}\/[^/]+$/.test(p)) throw Object.assign(new Error("업로드 경로가 올바르지 않습니다."), { status: 400 });
    const buf = await getObject("incoming", p);
    await removeObjects("incoming", [p]).catch(() => {});
    if (!buf) throw Object.assign(new Error("업로드한 파일을 찾을 수 없습니다. 다시 올려주세요."), { status: 400 });
    if (buf.length > maxBytes) throw Object.assign(new Error(`${names[i] ?? "파일"}: 파일이 너무 큽니다.`), { status: 413 });
    out.push({ name: names[i] || p.split("/").pop()!, type: "", buffer: buf });
  }
  return out;
}

export async function readUpload(form: FormData, field: string, maxBytes: number) {
  return (await readUploads(form, field, maxBytes))[0] ?? null;
}

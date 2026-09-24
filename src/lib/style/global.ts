import "server-only";
import { getSetting, setSetting } from "../app-settings";

/** style reference 폴더로 학습한 기본 문체 프로필 — 새 프로젝트에 자동 적용 */
export type GlobalStyle = { profile: any; files: string[]; analyzedAt: string };

/** DB(AppSetting "globalStyle")에 보관 */
export async function readGlobalStyle(): Promise<GlobalStyle | null> {
  return getSetting<GlobalStyle>("globalStyle");
}

export async function writeGlobalStyle(g: GlobalStyle) {
  await setSetting("globalStyle", g);
}

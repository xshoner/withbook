# withbook — 작가 서포트 집필 에이전트

스케치를 작가의 문체로 원고화하고, 부크크 A5(148×210mm) 인쇄 규격 그대로 PDF·HWPX로 내보내는 웹앱.
웹: https://withbook.vercel.app (로그인 필요) · 배포 구성: [docs/deployment.md](docs/deployment.md)

요구사항: [prd.md](prd.md) · 프롬프트: [prompts.md](prompts.md) · 결정 기록: [docs/decisions.md](docs/decisions.md) · 검토 기록: [docs/review-2026-09-24.md](docs/review-2026-09-24.md)

## 구성

- Next.js(App Router) · Tiptap 편집기 · Paged.js 조판
- Supabase: Postgres(원고, `withbook` 스키마) · Storage(이미지·문체 자료·내보내기·글꼴) · Auth(로그인)
- Vercel 배포. PDF는 서버용 Chromium(@sparticuz/chromium), 로컬은 설치된 Edge/Chrome
- AI: OpenAI 호환 Chat Completions (게이트웨이·Gemini·OpenAI·Anthropic) — [책 설정 → AI 설정]

## 로컬 실행

```bash
npm install
cp .env.example .env   # Supabase·DB 값을 채운다
npm run dev
```

http://localhost:3100 — `APP_ACCESS_MODE=local`이면 로그인 없이 이 컴퓨터에서만 열린다.
KoPub 글꼴은 로컬 `public/fonts/`(KoPubBatangLight/Bold, KoPubDotumMedium .ttf) 또는 Supabase `fonts` 버킷.

## 사용 흐름
1. 로그인 → **프로젝트 선택** → 새 프로젝트: 책 정보 → AI 목차 설계 → [이 목차로 시작]
2. 목차에서 절 선택 → 스케치 → 분량 → **[AI 집필하기]** (여러 절은 [다중 집필])
3. 직접 고치기(자동 저장) · 선택영역 AI · 각주 · 교정·교열
4. **[펼침면 미리보기]** → **[내보내기]** PDF(부크크 제출용) / HWPX / 백업

- **삭제·되돌리기**: 장·절을 지우면 알림의 [되돌리기]로 바로 살리거나, 목차 아래 [삭제한 장·절]에서 30일 안에 되돌린다(버전 기록 포함, 용량이 크면 원고만). AI 집필·교정 중인 절을 지우려 하면 작업을 먼저 멈출지 묻는다.
- **AI 집필·교정은 백그라운드로** 돈다: 쓰는 동안 다른 절로 옮겨 편집해도 계속되고, 끝나면 알림으로 알린다. 덮어쓰기·분량 조정·교정 중에는 그 절만 잠긴다. 이어쓰기는 쓰는 중에도 그 절을 고칠 수 있고, 다 쓰면 그때의 본문 끝에 붙인다. 한 절에서 집필과 교정은 동시에 하지 않는다(다중 집필은 작업 중인 절을 건너뛴다).
- 작업은 **브라우저 탭에서** 돈다 — 탭을 닫거나 새로 고치면 끊긴다(닫기 전에 한 번 묻는다). 끝난 교정 내역은 서버에 7일 보관해 새로 고친 뒤에도 [교정 내역]에서 확인·되돌리기할 수 있다.

## 폴더
```
prompts/            런타임 AI 프롬프트 (*.system.md / *.user.md, {{변수}})
src/lib/print/      인쇄 규격 상수(spec.ts), 조판 HTML(bookHtml.ts)
src/lib/ai/         AI 클라이언트·설정, 프롬프트 조립, 작업(목차·집필·교정·요약·문체·각주)
src/lib/export/     PDF(Playwright+Chromium), HWPX(OWPML), 사전 점검
src/lib/storage.ts  파일 저장소 (Supabase Storage / 로컬 data 폴더)
src/proxy.ts        로그인 확인(Supabase 세션) · 요청 출처 검사
scripts/            데이터 이전(migrate-to-supabase.mjs) · 통합 검사(smoke-test.mjs)
```

## 보안
- 공개 저장소에는 원고·문체 자료·개인 서술 규칙(instruction.md)·글꼴 원본·`.env`를 올리지 않는다.
- API 키·Supabase 비밀 키는 서버에만 있다(Vercel 환경변수 또는 DB). 화면에는 가려서만 표시한다.
- 앱 표는 공개 API에서 막힌 `withbook` 스키마 + RLS. 로그인은 역할(superadmin/editor)이 있는 계정만.

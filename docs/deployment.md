# 웹 배포 (Vercel + Supabase)

구성: **Vercel**(Next.js 서버리스) · **Supabase Postgres**(원고 DB, `withbook` 스키마) · **Supabase Storage**(이미지·문체 자료·내보내기 파일·글꼴) · **Supabase Auth**(로그인).

| 버킷 | 공개 | 내용 |
|---|---|---|
| `assets` | 비공개 | 원고 이미지 (`projects/{프로젝트}/{이미지}.png`) |
| `style-reference` | 비공개 | 문체 학습 자료 (한글 파일명은 base64url 키) |
| `exports` | 비공개 | 내보낸 PDF·HWPX·백업 ZIP (10분 서명 주소로 내려받기, 하루 지나면 정리) |
| `incoming` | 비공개 | 3.5MB 넘는 업로드를 브라우저가 직접 올리는 대기 공간 (하루 지나면 정리) |
| `fonts` | 공개 | KoPub 글꼴 (편집 화면·PDF 조판용) |

## 보안 원칙

- GitHub 저장소는 **공개**이므로 원고 DB, `style reference/`, `instruction.md`(개인 서술 규칙), 글꼴 원본, `.env`는 올리지 않는다(`.gitignore`).
- 앱 표는 `withbook` 스키마에 두고 공개 키(Data API)의 접근을 막으며 모든 표에 RLS를 켠다. 서버만 DB 비밀번호로 접속한다.
- 로그인은 Supabase Auth. 계정의 `app_metadata.role`이 `superadmin`/`editor`인 사용자만 들어올 수 있다(사용자가 스스로 바꿀 수 없는 값). **Supabase 대시보드 → Authentication → Sign In / Providers에서 "Allow new users to sign up"을 끈다.**
- 모든 API는 proxy.ts와 별도로 라우트 안(`handle()`)에서도 로그인 세션과 역할을 다시 확인한다. AI 설정·instruction·기본 문체(학습 자료) 변경은 `superadmin`만 할 수 있다.
- PDF 조판은 서버 안 Chromium이 5분짜리 내부 토큰(`RENDER_SECRET`으로 서명, 해당 프로젝트에 묶임)으로 조판 페이지만 연다. 웹 배포는 전용 `RENDER_SECRET`을 넣는다(없으면 `SUPABASE_SECRET_KEY`로 서명하고 경고 로그).
- AI 키는 [책 설정 → AI 설정]에 저장하면 DB에 보관되고 화면에는 가려서만 보인다. 키 이름은 `…_API_KEY` 형식만 쓸 수 있고 앱 비밀(`SUPABASE_*`·`DATABASE_*` 등)은 거부한다. 기본 주소는 https만, 내부망·localhost·메타데이터 주소는 거부하며, `AI_ALLOWED_HOSTS`(쉼표 목록)를 넣으면 그 호스트만 허용한다.
- AI 서버의 오류 응답 본문은 서버 로그에만 남고 화면에는 상태 코드와 안내만 보인다.

## 처음 배포하기

1. **Supabase 값 준비**
   - Project Settings → API Keys: Publishable key(공개), **Secret key(`sb_secret_…`, 서버 전용)**
   - Connect → Connection string: **Transaction pooler(6543)** 와 **Session pooler(5432)** 주소, DB 비밀번호
2. **로컬 `.env`** 에 `.env.example`의 Supabase·DB 값을 채운다.
3. **데이터 이전** (2026-09에 1회 완료 — 기록용. 원고·이미지·글꼴·문체 자료·학습된 문체 프로필·AI 설정·instruction.md·최초 관리자 계정):
   ```sh
   node --env-file=.env scripts/archive/migrate-to-supabase.mjs
   ```
   관리자 계정은 실행할 때만 넘긴다(저장하지 않음). PowerShell 예:
   ```powershell
   $env:ADMIN_EMAIL='관리자 이메일'; $env:ADMIN_PASSWORD='최초 비밀번호'; node --env-file=.env scripts/archive/migrate-to-supabase.mjs
   ```
   여러 번 실행해도 이미 있는 항목은 건너뛴다. 관리자 비밀번호는 로그인 후 바꾸는 것을 권장한다.
   이 스크립트는 `scripts/archive/`로 옮겼고, 쓰던 `AppUser` 모델이 스키마에서 빠져 지금 그대로는 실행되지 않는다(다시 필요하면 그 시점 커밋에서 실행). 이전 전 로컬 SQLite 원본은 `data/_legacy-sqlite/`(git 제외)에 남아 있다.
4. **Vercel**: GitHub 저장소를 Import → Environment Variables에 아래 값을 넣고 배포.
   ```dotenv
   APP_ACCESS_MODE=web
   APP_ORIGIN=https://withbook.vercel.app
   NEXT_PUBLIC_SUPABASE_URL=https://tboxtseswieqqzniakkb.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
   SUPABASE_SECRET_KEY=sb_secret_…
   DATABASE_URL=postgresql://…:6543/postgres?pgbouncer=true&connection_limit=5&pool_timeout=20&schema=withbook
   DIRECT_URL=postgresql://…:5432/postgres?schema=withbook
   RENDER_SECRET=(openssl rand -hex 32 등 임의 값)
   AI_ALLOWED_HOSTS=gw.letsur.ai,generativelanguage.googleapis.com,api.openai.com,api.anthropic.com
   ```
   `connection_limit=5`: 트랜잭션(목차 편집·복원·복제)과 병렬 조회가 연결 1개에서 줄 서지 않게 한다. `pool_timeout=20`: 연결을 20초까지 기다린다.
   `NEXT_PUBLIC_*`·`APP_ACCESS_MODE`는 빌드 때 화면에 들어가므로 값을 바꾸면 다시 배포한다.
5. Supabase → Authentication → URL Configuration의 Site URL을 `https://withbook.vercel.app`으로 둔다.
6. **스키마 반영**: 표·열·인덱스가 바뀌면(예: `AiLog.userId`, 목차·버전·사용 기록 인덱스) 로컬에서 `npm run db:push`로 Supabase에 반영한다(`DIRECT_URL` 사용). 배포 전에 한 번 실행한다.
   - 운영 DB의 옛 `withbook."AppUser"` 표는 더 이상 쓰지 않는다(역할은 Supabase Auth `app_metadata.role`). 스키마에서 모델을 뺐으므로 다음 `npm run db:push`는 이 표를 지우려 하고, 표에 행이 있으면 데이터 손실 경고로 멈춘다(대화형이면 확인을 묻는다). 이 표 말고 다른 표가 지워지지 않는지 경고 목록을 확인한 뒤 진행하거나, 먼저 Supabase SQL 편집기에서 `drop table withbook."AppUser";`로 직접 지운다.
7. **글꼴**: KoPub TTF를 WOFF2로 바꿔(약 1/3 크기) 함께 올린다. 화면·조판은 WOFF2를 먼저 받고 없으면 TTF를 쓴다.
   ```sh
   npx ttf2woff2 < public/fonts/KoPubBatangLight.ttf > public/fonts/KoPubBatangLight.woff2   # 세 글꼴 모두
   node --env-file=.env scripts/upload-fonts.mjs   # fonts 버킷에 1년 캐시로 올림
   ```
8. **상태 확인**: `GET /api/health` → `{ ok, db, storage, time }` (로그인 없이 열림, 값은 참/거짓만). 문제가 있으면 503.

## Vercel 제약과 대응

- **요청·응답 4.5MB 제한**: 큰 업로드는 브라우저가 `incoming` 버킷에 직접 올리고, 내보내기 파일은 `exports` 버킷의 서명 주소로 내려받는다. 글꼴은 공개 `fonts` 버킷 주소로 넘긴다.
- **실행 시간 300초**: AI 집필·교정·PDF 경로는 `maxDuration = 300`. AI 호출은 요청 하나당 재시도·대기(Retry-After 포함)를 합쳐 240초 안에서 끝내고, 스트리밍 중 한도에 걸리면 받은 부분까지로 끝낸다. PDF는 **요청 시작부터** 재서 조판 완료를 245초(페이지 열기 최대 60초), PDF 인쇄를 280초 안에서 끝내고(판형 보정·점검·업로드에 나머지를 남긴다), 넘으면 한국어 안내와 함께 504로 알린다. 조판 페이지가 글꼴(KoPub 바탕 Light·Bold, 돋움)이나 이미지를 불러오지 못했거나 PDF에 KoPub 글꼴이 들어가지 않았으면 조용히 내보내지 않고 무엇이 빠졌는지 알리며 멈춘다(422). 아주 긴 절(분할 집필)이 300초를 넘기면 그때까지 쓴 부분이 저장된다 — [뒤에 이어쓰기]로 마저 쓴다. Vercel Pro는 최대 800초까지 늘릴 수 있다.
- **파일 시스템 없음**: 설정·문체 프로필·instruction은 DB(`AppSetting` 표), 파일은 Storage.
- **PDF**: `@sparticuz/chromium`(서버용 Chromium)을 쓴다. 로컬은 설치된 Edge/Chrome.

## 로컬 실행

```sh
npm ci
npm run dev
```

로컬도 같은 Supabase DB를 쓴다(`.env`의 `DATABASE_URL`). `APP_ACCESS_MODE=local`이면 로그인 없이 이 컴퓨터에서만 열린다. Supabase 비밀 키를 비우면 파일은 `data/storage`에 저장된다.

## 백업

- 원고 입력은 자동 저장(순차 큐·오프라인 복구본). 절마다 버전 기록(원고 전체를 담으므로 DB 용량을 위해 제한): 자동 저장 최근 10개 + 그 이전 14일은 하루 1개 · 직접 저장 30개 · AI 초안 원본 3개 · 그 밖(AI 집필 전·교정 전·복원 전 등) 30개.
- 프로젝트 ZIP: [내보내기 → 백업]. 표지 디자인·절 참고 자료·고친 개요·만든 그림 목록(extras.json)과 manifest.json(빠진 이미지·담지 않은 것)도 담는다. 복원 한도 50MB를 넘으면 내려받을 때 알리고, 백업 때 저장소에 없던 이미지는 복원에서 건너뛰고 알린다. 기본은 버전 기록을 빼고(현재 원고·이미지), [버전 기록 포함]을 켜면 담는다. 장·이미지를 하나씩 ZIP에 흘려 넣어 메모리를 적게 쓴다. 복원은 두 형식 모두 받는다. DB 전체 백업은 Supabase(유료 플랜 일일 백업/PITR) 또는 `pg_dump`로 한다.
- 휴지통 프로젝트는 30일 뒤 자동 삭제.
- 지운 장·절도 30일 보관한다(`AppSetting`의 `trash:` 키). 삭제 알림의 [되돌리기] 또는 목차의 [삭제한 장·절]에서 되돌린다. 지우기 전에 밀린 자동 저장을 먼저 보내고, 지운 절로 가는 저장(404)은 되풀이하지 않고 버린다.
- AI 집필 중 받은 글은 5초마다 `AppSetting`의 `ai-partial:{절 id}`에 보관한다(7일). 정상으로 끝나면 다 쓴 글을 `complete`로 저장한 **뒤** 끝 신호를 보내고, 브라우저가 본문 저장(또는 새 버전 후보 선택)을 마친 뒤 지운다 — 그 사이 탭이 닫혀도 [중단된 AI 집필]로 되찾는다. 이미 본문에 들어간 글이면 알리지 않고 치운다.
- 편집기 밖에서 끝난 AI 덮어쓰기·분량 조정은 시작 때 읽은 본문 해시로 저장한다 — 그사이 다른 창에서 고쳤으면 덮지 않고 저장 충돌로 남긴다(그 절을 열면 두 원고를 비교해 고른다). `GET/DELETE /api/sections/[id]/partial`.
- 하루 한 번 정리(프로젝트 목록 응답을 보낸 뒤 `after()`로, 마지막 실행 날짜는 `AppSetting`의 `maintenance:last`): 휴지통 프로젝트·장·절(30일), 개요 캐시(1일), AI 부분 원고(7일), `exports`·`incoming` 버킷의 하루 지난 파일.
- 절별 참고 자료는 `ref:{절}:{자료}`, 작가가 고친 개요는 `outline-edit:{절}`에 둔다(절·장을 지우면 휴지통 항목에 함께 담기고, 목차 교체·책 영구 삭제 때 지운다). 책 단위: 마지막 PDF 점검 `pdf-check:{책}`, 실제 쪽수 `pages:{책}`, 일관성 검사·베타 리더 결과 `ai:consistency:*`·`ai:beta:*`(내용 해시가 같으면 다시 부르지 않음), 원고 가져오기 분석 `manuscript-import:*`.
- 장 퇴고 기록: 한 번 적용할 때마다 장 안 모든 절의 바뀐 문단을 `revise-run:{책}:{장}:{run}`에, 절별 버전에서 찾는 표시를 `revise-ver:{버전}`에 둔다(30일, 책 영구 삭제 때 함께 지움). [퇴고 이력]·버전 기록에서 한눈에 보고 한 번에 되돌린다 — 그 뒤 손대지 않은 절은 퇴고 전 버전으로, 고친 절은 퇴고로 바뀐 문장만 되돌린다.
- 끝난 교정 결과(변경 내역·교정 전 원고)는 `AppSetting`의 `proof-result:{절 id}` 키에 7일 보관한다(새 교정을 시작하거나 [전체 되돌리기]하면 지운다).

## 백그라운드 작업(AI 집필·교정)

- 작업은 서버가 아니라 **작가의 브라우저 탭**이 요청을 들고 기다린다. 다른 절로 옮겨도 계속되지만, 탭을 닫거나 새로 고치면 끊긴다(작업 중에는 닫기 전에 묻는다). 집필은 끊긴 시점까지 받은 글을 넣지 못할 수 있다.
- 한 절에서 집필과 교정은 겹치지 않는다. 자동 집필은 이미 작업 중인 절을 건너뛰고 알린다.
- 각 요청은 Vercel 실행 시간(300초) 안에서 끝나야 한다 — 위 [Vercel 제약과 대응] 참고.

## 검증 명령

```sh
npm test
npm run typecheck
npm run build
SMOKE_DATABASE_URL=postgresql://…(테스트용 Postgres) npm run test:smoke
```

`test:smoke`는 실행마다 새 스키마(`smoke_…`)를 만들어 쓰고 작가 데이터에는 접근하지 않는다. 운영 Supabase가 아닌 테스트용 Postgres를 지정한다.

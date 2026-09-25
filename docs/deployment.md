# 웹 배포 (Vercel + Supabase)

구성: **Vercel**(Next.js 서버리스) · **Supabase Postgres**(원고 DB, `withbook` 스키마) · **Supabase Storage**(이미지·문체 자료·내보내기 파일·글꼴) · **Supabase Auth**(로그인).

| 버킷 | 공개 | 내용 |
|---|---|---|
| `assets` | 비공개 | 원고 이미지 (`projects/{프로젝트}/{이미지}.png`) |
| `style-reference` | 비공개 | 문체 학습 자료 (한글 파일명은 base64url 키) |
| `exports` | 비공개 | 내보낸 PDF·HWPX·백업 ZIP (10분 서명 주소로 내려받기) |
| `incoming` | 비공개 | 3.5MB 넘는 업로드를 브라우저가 직접 올리는 대기 공간 |
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
3. **데이터 이전** (원고·이미지·글꼴·문체 자료·학습된 문체 프로필·AI 설정·instruction.md·최초 관리자 계정):
   ```sh
   node --env-file=.env scripts/migrate-to-supabase.mjs
   ```
   관리자 계정은 실행할 때만 넘긴다(저장하지 않음). PowerShell 예:
   ```powershell
   $env:ADMIN_EMAIL='관리자 이메일'; $env:ADMIN_PASSWORD='최초 비밀번호'; node --env-file=.env scripts/migrate-to-supabase.mjs
   ```
   여러 번 실행해도 이미 있는 항목은 건너뛴다. 관리자 비밀번호는 로그인 후 바꾸는 것을 권장한다.
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
7. **글꼴**: KoPub TTF를 WOFF2로 바꿔(약 1/3 크기) 함께 올린다. 화면·조판은 WOFF2를 먼저 받고 없으면 TTF를 쓴다.
   ```sh
   npx ttf2woff2 < public/fonts/KoPubBatangLight.ttf > public/fonts/KoPubBatangLight.woff2   # 세 글꼴 모두
   node --env-file=.env scripts/upload-fonts.mjs   # fonts 버킷에 1년 캐시로 올림
   ```
8. **상태 확인**: `GET /api/health` → `{ ok, db, storage, time }` (로그인 없이 열림, 값은 참/거짓만). 문제가 있으면 503.

## Vercel 제약과 대응

- **요청·응답 4.5MB 제한**: 큰 업로드는 브라우저가 `incoming` 버킷에 직접 올리고, 내보내기 파일은 `exports` 버킷의 서명 주소로 내려받는다. 글꼴은 공개 `fonts` 버킷 주소로 넘긴다.
- **실행 시간 300초**: AI 집필·교정·PDF 경로는 `maxDuration = 300`. AI 호출은 요청 하나당 재시도·대기(Retry-After 포함)를 합쳐 240초 안에서 끝내고, 스트리밍 중 한도에 걸리면 받은 부분까지로 끝낸다. PDF는 브라우저 실행부터 조판 완료까지 250초(페이지 열기 최대 60초) 안에서 끝내고, 넘으면 한국어 안내와 함께 504로 알린다. 아주 긴 절(분할 집필)이 300초를 넘기면 그때까지 쓴 부분이 저장된다 — [뒤에 이어쓰기]로 마저 쓴다. Vercel Pro는 최대 800초까지 늘릴 수 있다.
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
- 프로젝트 ZIP: [내보내기 → 백업]. DB 전체 백업은 Supabase(유료 플랜 일일 백업/PITR) 또는 `pg_dump`로 한다.
- 휴지통 프로젝트는 30일 뒤 자동 삭제.
- 지운 장·절도 30일 보관한다(`AppSetting`의 `trash:` 키). 삭제 알림의 [되돌리기] 또는 목차의 [삭제한 장·절]에서 되돌린다. 지우기 전에 밀린 자동 저장을 먼저 보내고, 지운 절로 가는 저장(404)은 되풀이하지 않고 버린다.
- 끝난 교정 결과(변경 내역·교정 전 원고)는 `AppSetting`의 `proof-result:{절 id}` 키에 7일 보관한다(새 교정을 시작하거나 [전체 되돌리기]하면 지운다).

## 백그라운드 작업(AI 집필·교정)

- 작업은 서버가 아니라 **작가의 브라우저 탭**이 요청을 들고 기다린다. 다른 절로 옮겨도 계속되지만, 탭을 닫거나 새로 고치면 끊긴다(작업 중에는 닫기 전에 묻는다). 집필은 끊긴 시점까지 받은 글을 넣지 못할 수 있다.
- 한 절에서 집필과 교정은 겹치지 않는다. 다중 집필은 이미 작업 중인 절을 건너뛰고 알린다.
- 각 요청은 Vercel 실행 시간(300초) 안에서 끝나야 한다 — 위 [Vercel 제약과 대응] 참고.

## 검증 명령

```sh
npm test
npm run typecheck
npm run build
SMOKE_DATABASE_URL=postgresql://…(테스트용 Postgres) npm run test:smoke
```

`test:smoke`는 실행마다 새 스키마(`smoke_…`)를 만들어 쓰고 작가 데이터에는 접근하지 않는다. 운영 Supabase가 아닌 테스트용 Postgres를 지정한다.

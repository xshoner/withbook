# BookK Writer — 작가 서포트 집필 에이전트

최근 개선: [코드 검토 기록](docs/review-2026-09-24.md) · [자동저장 및 웹 배포 안내](docs/deployment.md)

스케치를 작가의 문체로 원고화하고, 부크크 A5(148×210mm) 인쇄 규격 그대로 PDF·HWPX로 내보내는 로컬 웹앱.
요구사항: [prd.md](prd.md) · 서술 규칙: [instruction.md](instruction.md) · 프롬프트: [prompts.md](prompts.md) · 결정 기록: [docs/decisions.md](docs/decisions.md)

## 실행

```bash
npm install
npx prisma db push
npm run dev
```

브라우저에서 http://localhost:3100 을 연다.

### 처음 한 번 준비
1. `.env.example`을 `.env`로 복사하고 `LLM_API_KEY`를 넣는다(이미 있으면 생략).
2. KoPub 글꼴 파일을 `public/fonts/`에 둔다: `KoPubBatangLight.ttf`, `KoPubBatangBold.ttf`, `KoPubDotumMedium.ttf`
   (Windows에 설치돼 있으면 `C:\Windows\Fonts`에서 복사).
3. PDF 출력은 설치된 Edge 또는 Chrome을 쓴다. 다른 경로면 `.env`의 `PDF_BROWSER_PATH`에 지정.
4. `style reference/` 폴더에 작가의 글(txt·pdf·docx·hwpx)을 넣고 [설정 → 작가 문체 학습]을 누른다.

## 사용 흐름
1. **새 프로젝트** → 책 정보 입력 → AI 목차 설계 보고서 → [이 목차로 시작]
2. 왼쪽 목차에서 절 선택 → 스케치 입력 → 분량(페이지) 지정 → **[집필하기]**
3. 직접 고치기(자동 저장) · 선택 영역 AI(다듬기/늘리기/줄이기/톤/예시)
4. **[교정·교열]** → 변경 내역 확인, 개별/전체 되돌리기
5. **[펼침면 미리보기]**로 독자 시점 확인(재단선·안전 영역·본문 영역 가이드)
6. **[내보내기]** → PDF(154×216 재단 여백 포함, 부크크 제출용) / HWPX / 백업

## 폴더
```
prompts/            런타임 AI 프롬프트 (*.system.md / *.user.md, {{변수}})
src/lib/print/      인쇄 규격 상수(spec.ts), 조판 HTML(bookHtml.ts)
src/lib/ai/         게이트웨이 클라이언트, 프롬프트 조립, 작업(목차·집필·교정·요약·문체)
src/lib/export/     PDF(Playwright+Edge), HWPX(OWPML), 사전 점검
src/components/     목차 패널, 편집기, 미리보기, 내보내기
data/               SQLite DB, 이미지, 백업, 기본 문체 프로필 (git 제외)
```

## 보안
- API 키는 `.env` 또는 [책 설정 → AI 설정]에서 저장한 `data/ai-settings.json`에만 있고 브라우저로 전달되지 않는다(화면에는 가려서 표시, 모든 AI 호출은 서버 라우트 경유).
- `.env`, `data/`, 글꼴 파일은 `.gitignore`로 제외된다.

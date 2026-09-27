# scripts/archive — 한 번 쓰고 끝난 / 옛 구조용 스크립트

지금 앱 운영에는 필요 없습니다. 기록·재현용으로만 남겨 둡니다.

- `migrate-to-supabase.mjs` — 2026-09 로컬(SQLite `data/app.db` + `data/` 폴더) → Supabase(Postgres·Storage·Auth) 1회 이전 스크립트. 이전은 끝났고, 이 스크립트가 쓰던 `AppUser` 모델은 `prisma/schema.prisma`에서 빠졌으므로 **지금 그대로는 실행되지 않습니다**(다시 돌리려면 그 시점 커밋으로 되돌려 실행).
- `seed-test.js` — 초기 조판·출력 점검용 샘플 프로젝트 생성기(SQLite 시절, 현재 스키마의 필수 값(사용자 등)과 맞지 않을 수 있음).

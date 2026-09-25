// KoPub 글꼴을 Supabase 공개 fonts 버킷에 올린다 (TTF + WOFF2, 1년 캐시).
// WOFF2 만들기: npx ttf2woff2 < public/fonts/X.ttf > public/fonts/X.woff2
// 실행: node --env-file=.env scripts/upload-fonts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY가 필요합니다.');
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const dir = path.resolve('public/fonts');
const names = ['KoPubBatangLight', 'KoPubBatangBold', 'KoPubDotumMedium'];
for (const n of names) {
  for (const [ext, type] of [['woff2', 'font/woff2'], ['ttf', 'font/ttf']]) {
    const file = path.join(dir, `${n}.${ext}`);
    if (!fs.existsSync(file)) {
      console.log('건너뜀(파일 없음)', file);
      continue;
    }
    const { error } = await sb.storage.from('fonts').upload(`${n}.${ext}`, fs.readFileSync(file), { upsert: true, contentType: type, cacheControl: '31536000' });
    if (error) throw new Error(`${n}.${ext}: ${error.message}`);
    console.log('올림', `${n}.${ext}`, `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)}MB`);
  }
}

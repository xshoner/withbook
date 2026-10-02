[책 정보]
- 제목: {{title}} / 부제: {{subtitle}}
- 저자: {{author}}
- 주제/분야: {{topic}}
- 집필 의도: {{intent}}
- 주요 대상 독자: {{audience}}
- 핵심 메시지: {{keyMessage}}
- 톤: {{tone}}
- 참고·경쟁 도서: {{references}}
- 목표 총 페이지(A5): {{targetPages}}
- 기타 요청: {{extra}}

[작가 문체 프로필]
{{styleProfile}}

{{#if regenerate}}[재설계 요청] 이전 안과 다른 구성 원리로 설계하라. 이전 안 요약: {{previousConcept}} {{/if}}
{{#if chapterOnly}}[부분 재설계] {{chapterIndex}}장만 다시 설계하라. 출력 JSON의 chapters 배열에는 다시 설계한 그 장 하나만 넣는다. 나머지 목차: {{currentToc}} {{/if}}
{{#if detailOnly}}[장별 세부 설계] 아래는 이미 정한 목차 골격이다. {{chapterIndex}}장 하나만 세부 설계하라. 장 제목·약속·절 제목·절 순서·절 개수·권장 분량은 골격 그대로 두고, 장의 rationale(이 장을 이 위치에 둔 이유, 전문가 관점·트렌드 근거)과 절마다 gist(한 줄 요지)·hook(독자 흥미 포인트)을 채운다. 앞뒤 장과 내용이 겹치지 않게 한다. 출력은 {"chapters": [그 장 하나]} 형태의 JSON 하나만. 목차 골격:
{{currentToc}} {{/if}}

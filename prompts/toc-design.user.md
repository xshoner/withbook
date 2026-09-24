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

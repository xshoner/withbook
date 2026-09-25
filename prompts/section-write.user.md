지금 쓸 부분: {{chapterNo}} 「{{chapterTitle}}」 > {{sectionNo}} 「{{sectionTitle}}」
이 절의 요지(목차 설계): {{sectionGist}}

[앞선 원고의 문맥 — 출처가 표시된 최신 요약과 원문 발췌]
{{previousSummaries}}
이미 다룬 주장·사례를 반복하지 말고 앞 논의를 이어 간다. 수치·인용·고유명사는 원문을 기준으로 삼는다. 발췌되지 않은 부분의 내용을 추측하거나, 발췌에 없다는 이유로 책에서 다루지 않았다고 단정하지 않는다.

[바로 앞 절의 마지막 부분 — 여기서 자연스럽게 이어진다]
{{previousTail}}

[다음 절 요지 — 내용을 미리 당겨 쓰지 않는다]
{{nextGist}}

[작가 스케치 — 빠짐없이 반영한다]
{{sketch}}

[분량]
목표 {{targetPages}}페이지 = 공백 포함 약 {{targetChars}}자 (허용 범위 {{minChars}}~{{maxChars}}자)
분량은 반드시 {{minChars}}자 이상 채운다. 짧게 끝내지 말고, 모자라면 스케치 항목마다 사례·배경·해석을 한 단락씩 더 풀어 쓴다. 같은 말을 되풀이해 채우지는 않는다.

[맺음]
후킹·공감·사유 유도 흐름은 유지하되, CTA는 {{#if lastInChapter}}이 절이 장의 마지막 절이므로 장 전체를 닫는 성찰과 질문으로 여운 있게 맺는다.{{else}}절의 마지막 문단에서 다음 절로 이어지는 질문이나 여운으로 가볍게 대신한다.{{/if}}

{{#if extraInstruction}}[이번 요청의 추가 지시 — 최우선]
{{extraInstruction}}{{/if}}

{{#if mode_continue}}[이어쓰기] 아래 기존 본문 뒤에 이어서 쓴다. 기존 본문은 다시 출력하지 않는다.
{{existingContent}}{{/if}}

{{#if partInfo}}{{partInfo}}{{/if}}

instruction.md 7장의 출력 형식에 따라 본문만 출력하라.

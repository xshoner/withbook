// 조판·출력 점검용 샘플 프로젝트 생성: node scripts/seed-test.js
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const para = (t) => ({ type: "paragraph", content: [{ type: "text", text: t }] });
const lorem =
  "인공지능이 우리 일상에 들어온 속도는 생각보다 훨씬 빨랐습니다. 몇 해 전만 해도 먼 미래의 이야기처럼 들리던 기술이 이제는 아이의 숙제 옆에, 부모의 스마트폰 안에 자연스럽게 자리 잡았죠. 그런데 그 변화의 한가운데에서 우리는 정작 무엇을 준비해야 하는지 잘 모릅니다. ";
const body = (n) => Array.from({ length: n }, (_, i) => para(lorem + lorem.slice(0, (i * 37) % lorem.length)));
const count = (c) => c.reduce((a, n) => a + JSON.stringify(n).length * 0 + (n.content ?? []).reduce((b, x) => b + (x.text?.length ?? (x.content?.[0]?.content?.[0]?.text?.length ?? 0)), 0), 0);

(async () => {
  const proj = await p.project.create({
    data: { title: "조판 테스트 책", subtitle: "PDF·HWPX 출력 점검용", author: "지병석", targetPages: 40, layout: "{}" },
  });
  const mk = (kind, order, title, secs) =>
    p.chapter.create({
      data: {
        projectId: proj.id,
        kind,
        order,
        title,
        sections: {
          create: secs.map((s, i) => ({
            order: i + 1,
            title: s.t,
            targetPages: 3,
            status: "editing",
            content: JSON.stringify({ type: "doc", content: s.c }),
            charCount: count(s.c),
          })),
        },
      },
    });
  await mk("front", 1, "머리말", [{ t: "머리말", c: body(6) }]);
  await mk("body", 2, "왜 지금 질문하는 힘인가", [
    { t: "답이 넘치는 시대", c: [...body(8), { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "검색에서 대화로" }] }, ...body(8)] },
    { t: "아이의 첫 AI 친구", c: body(10) },
  ]);
  await mk("body", 3, "부모가 먼저 배워야 할 것", [
    { t: "두려움 대신 호기심", c: body(12) },
    { t: "집에서 시작하는 AI 대화", c: [...body(5), { type: "blockquote", content: [para("그때는 맞고 지금은 틀리다.")] }, ...body(5)] },
  ]);
  await mk("back", 4, "맺음말", [{ t: "맺음말", c: body(4) }]);
  console.log(proj.id);
  await p.$disconnect();
})();

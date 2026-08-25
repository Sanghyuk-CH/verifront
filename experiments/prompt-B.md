# 조건 B — 토큰 파일 제공

조건 A와 동일한 명세에 토큰 정의를 함께 준다.
`{{SCREEN_SPEC}}` 자리에 screen-spec.md 본문을, `{{TOKENS}}` 자리에 tokens.json 전문을 넣는다.

---

{{SCREEN_SPEC}}

**색상 규칙**

색은 반드시 아래 디자인 토큰으로만 지정한다. hex 값이나 rgb 값을 직접 쓰지 마라.
토큰은 CSS 커스텀 프로퍼티로 정의되어 있다. `color.primary` 는 `var(--color-primary)` 로 참조한다.

```json
{{TOKENS}}
```

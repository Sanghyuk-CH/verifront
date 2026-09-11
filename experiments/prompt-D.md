프로젝트 카드 리스트를 HTML + CSS로 만들어줘. 프레임워크 없이 순수 HTML과 CSS 한 벌로.

**구조**

카드 3개를 세로로 배열한다. 각 카드는 다음을 포함한다.

- 상태 배지 — 카드마다 다르다: `진행중` / `완료` / `보류`
- 제목 (h3)
- 설명 문단 2줄
- 메타 줄 — 작성자 이름과 수정 날짜, 가운데점으로 구분
- 하단 구분선
- 버튼 2개 — 주요 버튼 `열기`, 보조 버튼 `보관`

**상태**

- 카드 hover: 테두리 색이 바뀐다
- 주요 버튼 hover: 배경색이 바뀐다
- 보조 버튼은 세 번째 카드에서 disabled 상태다

**제약**

- 다크 모드 불필요
- 반응형 불필요
- 아이콘, 이미지 불필요
- CSS는 `<style>` 블록 하나에 넣는다

**색상 규칙**

색은 반드시 아래 디자인 토큰으로만 지정한다. hex 값이나 rgb 값을 직접 쓰지 마라.
토큰은 CSS 커스텀 프로퍼티로 정의되어 있다. `color.primary` 는 `var(--color-primary)` 로 참조한다.

```json
{
  "color": {
    "surface": "#ffffff",
    "surface-raised": "#f9fafb",
    "border": "#e5e7eb",
    "text": "#111827",
    "text-muted": "#6b7280",
    "primary": "#3b82f6",
    "primary-hover": "#2563eb",
    "primary-fg": "#ffffff",
    "success": "#16a34a",
    "success-soft": "#dcfce7",
    "warning": "#ca8a04",
    "warning-soft": "#fef9c3",
    "disabled": "#d1d5db",
    "disabled-fg": "#9ca3af"
  }
}
```

**간격 규칙**

여백은 반드시 아래 간격 토큰으로만 지정한다. padding, margin, gap 에 px 값을 직접 쓰지 마라.
토큰은 CSS 커스텀 프로퍼티로 정의되어 있다. `space.4` 는 `var(--space-4)` 로 참조한다.

```json
{
  "space": {
    "1": "4px",
    "2": "8px",
    "3": "12px",
    "4": "16px",
    "5": "20px",
    "6": "24px",
    "8": "32px",
    "10": "40px",
    "12": "48px",
    "16": "64px"
  }
}
```

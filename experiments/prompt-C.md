# 조건 C — 토큰 제공, 단 부족하게

조건 B와 동일하되 토큰 세트에서 hover·disabled 관련 3개를 뺀다.
빠진 것: `primary-hover`, `disabled`, `disabled-fg`

화면 명세는 여전히 hover 상태와 disabled 상태를 요구하므로,
생성 모델은 없는 색을 스스로 만들어내야 한다.

**판정은 전체 14개 토큰으로 한다.** 프롬프트에서 뺀 3개를 포함해서.
그래야 "모델이 만들어낸 hover 색이 실제 시스템의 값과 얼마나
어긋나는가" 를 잴 수 있다. 주는 것과 재는 것을 분리하는 것이
이 조건의 설계다.

프롬프트 본문은 prompt-B.md 와 같고, JSON 자리에
tokens-given-C.json 을 넣는다.

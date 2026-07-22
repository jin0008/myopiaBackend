# 챗봇 RAG 자료 관리 가이드

MyoDoc AI 상담(챗봇)은 **검수된 Q&A 자료**를 근거로 답합니다. 자료를 늘리거나
고치면 답변이 더 구체적·정확해집니다. 이 문서는 자료를 추가하고 반영하는 방법을
설명합니다.

## 구성 (백엔드 저장소 자체 완결)

```
src/assets/chat/
  qa/                 ← ★ Q&A 원본 (여기만 편집)
    01_atropine.md
    02_orthok.md
    ... (주제별 md)
  qa_index.json       ← 빌드 결과물 (임베딩 인덱스, 직접 편집 금지)
  prompt_base.txt     ← AI 지침 (필요 시 직접 편집)
  columns/            ← 읽을거리 칼럼 (챗봇과 별개)
scripts/
  build_index.py      ← qa/*.md → qa_index.json 재생성
```

동작: 질문이 오면 질문을 임베딩해 `qa_index.json`의 문항들과 코사인 유사도로
비교하고, 상위 K개(현재 `CHAT_CONFIG.ragTopK = 8`, `src/routes/mobile.ts`)의
본문을 Gemini 프롬프트에 넣어 답변을 만듭니다.

## 문항 작성 형식

`qa/` 안의 md 파일에서 문항은 `### [id] 질문` 헤더로 구분합니다.

```markdown
---
title: 주제 이름
topic: atropine
status: 검수 전 초안
updated: 2026-07-21
---

### [atropine-08] 아트로핀은 몇 살까지 써야 하나요?

여기에 부모가 이해하기 쉬운 말로, 구체적이고 자세하게 답을 씁니다. 길이가 길수록
답변도 상세해집니다. 숫자·조건·예외를 명확히 적어 주세요.

*참고: 근거 출처 URL — [검수 필요]*
```

규칙:
- **id는 전체에서 고유**해야 합니다 (예: `atropine-08`). 소문자·숫자·하이픈만.
- 한 문항 = `### [id] 질문` 한 줄 + 그 아래 본문.
- 맨 아래 `*참고: ...*` 줄에 근거 출처를 답니다 (검색·임베딩에는 제외됨).
- 새 주제는 새 md 파일(예: `08_surgery.md`)로 추가해도 됩니다.

## 반영 절차 (자료 수정 후)

```bash
cd myopiaBackend
# 1) qa/*.md 편집 또는 추가
# 2) 인덱스 재생성 (Gemini 임베딩 호출 → GEMINI_API_KEY 필요)
GEMINI_API_KEY=발급받은키 python3 scripts/build_index.py
# 3) 커밋 & 배포
git add src/assets/chat/qa src/assets/chat/qa_index.json
git commit -m "chore(chat): update QA material"
git push
# 4) 서버 재배포 (qa_index.json 이 함께 올라가면 반영됨)
```

> `build_index.py`는 `qa_index.json`만 다시 만듭니다. `prompt_base.txt`는 건드리지
> 않으니, AI의 말투·규칙을 바꾸려면 그 파일을 직접 편집 후 함께 배포하세요.

## 답변을 더 자세하게 만드는 다른 방법

`src/routes/mobile.ts`의 `CHAT_CONFIG`에서 조정할 수 있습니다:

| 값 | 현재 | 의미 |
|---|---|---|
| `ragTopK` | 8 | 답변에 참고하는 문항 수 (늘리면 근거↑, 토큰↑) |
| `maxOutputTokens` | 1400 | 답변 최대 길이 (잘리면 늘리기) |
| `model` (`CHAT_MODEL` env) | gemini-3.1-flash-lite | 상위 모델로 바꾸면 추론력↑ (비용↑) |

## 주의

- Q&A는 **의료 정보**입니다. 반영 전 **의료진 감수**를 거치세요. 각 문항의
  `status`/`참고` 줄로 검수 상태를 관리하면 좋습니다.
- `qa_index.json`을 직접 손으로 고치지 마세요 — 항상 `build_index.py`로 생성합니다.

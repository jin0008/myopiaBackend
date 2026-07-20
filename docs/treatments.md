# 근시 치료법 비교 콘텐츠 — 단일 소스 안내

웹 포털(myopiamanage.org)과 모바일 앱(MyoDoc)의 "근시 치료법 비교" 화면은
**하나의 소스**를 공유합니다. 한 곳만 고치면 웹·앱이 동시에 반영됩니다.

## 단일 소스 위치 (여기만 고치면 됩니다)

```
myopiaBackend/src/routes/mobile.ts  →  const TREATMENTS  (배열)
서빙 엔드포인트:  GET /api/mobile/treatments   (공개, 인증 불필요)
```

각 항목 구조:

```ts
{
  id: "atropine",          // 고유 id (URL·이미지 파일명에 사용)
  emoji: "💧",             // 앱 폴백 아이콘
  imageUrl: "/atropine.png", // 사이트 루트 기준 이미지 경로
  ko: { title, shortDescription, longDescription, mechanism, efficacy },
  en: { title, shortDescription, longDescription, mechanism, efficacy },
}
```

## 내용(문구)을 고칠 때

1. `mobile.ts`의 `TREATMENTS`에서 해당 항목의 `ko`/`en` 텍스트를 수정
2. 백엔드 빌드·재배포 (`npm run build` 후 배포)
3. 끝. 웹·앱 모두 자동 반영 (프론트 코드 수정 불필요)

## 치료법을 **추가**할 때

1. `mobile.ts`의 `TREATMENTS`에 새 항목 추가 (id·emoji·imageUrl·ko·en)
2. 이미지 추가: `myopia/public/<id>.png` 파일을 넣고 웹 재배포
   (이미지는 웹 사이트 루트에서 서빙되며, 앱은 그 URL을 그대로 불러옵니다)
3. 백엔드 재배포
4. 끝. 웹 목록/상세, 앱 목록/상세에 자동으로 나타납니다.

## 각 화면이 이 소스를 읽는 방식

| 화면 | 파일 | 데이터 취득 |
|---|---|---|
| 웹 목록 | `myopia/src/routes/Treatments.tsx` | `getTreatmentContent()` → `/api/mobile/treatments` |
| 웹 상세 | `myopia/src/routes/TreatmentDetail.tsx` | 동일 |
| 웹 API | `myopia/src/api/treatment_content.ts` | fetch 래퍼 |
| 앱 목록 | `myodoc/src/features/treatments/TreatmentsListScreen.tsx` | `apiFetch('/treatments')` |
| 앱 상세 | `myodoc/src/features/treatments/TreatmentDetailScreen.tsx` | 동일 |

## 참고 — 더 이상 쓰지 않는 파일

`myopia/src/data/treatments.ts` (예전 정적 콘텐츠)는 이제 사용되지 않습니다.
혼선을 막기 위해 콘텐츠는 위 백엔드 `TREATMENTS`에서만 관리하세요.
(파일 자체는 남겨두었으나 참조되지 않습니다.)

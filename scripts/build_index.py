#!/usr/bin/env python3
"""
src/assets/chat/qa/*.md  →  src/assets/chat/qa_index.json  (RAG 검색 인덱스)

각 Q&A 문항의 Gemini 임베딩을 계산해 저장합니다. 챗봇 서버(mobile.ts /chat)는
질문이 들어올 때마다 질문 임베딩 1회 + 코사인 유사도로 관련 문항 top-K 만 골라
프롬프트에 넣습니다.

사용법 (Q&A 파일 수정/추가 후 실행):
    GEMINI_API_KEY=... python3 scripts/build_index.py

배포:
    생성된 src/assets/chat/qa_index.json 을 커밋하고 백엔드를 재배포하면 반영됩니다.
    (prompt_base.txt 는 이 스크립트가 건드리지 않습니다 — 직접 편집하세요.)

문항 형식은 docs/rag-qa.md 참고.
"""
import json
import math
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QA_DIR = ROOT / "src" / "assets" / "chat" / "qa"
OUT_INDEX = ROOT / "src" / "assets" / "chat" / "qa_index.json"

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
EMB_MODEL = os.environ.get("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")
DIM = 768  # 768로 자르면 정규화가 풀리므로 아래에서 다시 정규화한다
BATCH = 10


def parse_items():
    """docs 형식: '### [id] 질문' 헤더로 문항을 구분한다."""
    items = []
    seen = set()
    for f in sorted(QA_DIR.glob("*.md")):
        text = f.read_text(encoding="utf-8")
        parts = re.split(r"^### \[([a-z0-9-]+)\] (.+)$", text, flags=re.M)
        # parts[0]=frontmatter, 이후 (id, 질문, 본문) 3개씩 반복
        for i in range(1, len(parts) - 2, 3):
            qid = parts[i]
            question = parts[i + 1].strip()
            body = parts[i + 2].strip()
            if not body:
                print(f"  경고: {qid} 본문 없음 — 건너뜀", file=sys.stderr)
                continue
            if qid in seen:
                sys.exit(f"중복 id: {qid} — id는 파일 전체에서 고유해야 합니다.")
            seen.add(qid)
            items.append({
                "id": qid,
                "q": question,
                "text": f"### [{qid}] {question}\n\n{body}",
            })
    return items


def normalize(vec):
    n = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [round(v / n, 5) for v in vec]


def embed_batch(texts):
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{EMB_MODEL}:batchEmbedContents"
    )
    payload = {"requests": [{
        "model": f"models/{EMB_MODEL}",
        "content": {"parts": [{"text": t}]},
        "taskType": "RETRIEVAL_DOCUMENT",
        "outputDimensionality": DIM,
    } for t in texts]}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": API_KEY},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.loads(r.read().decode())
    return [normalize(e["values"]) for e in res["embeddings"]]


def main():
    if not API_KEY:
        sys.exit("GEMINI_API_KEY 환경변수가 필요합니다 (임베딩 계산용).")
    if not QA_DIR.exists():
        sys.exit(f"Q&A 폴더가 없습니다: {QA_DIR}")

    items = parse_items()
    if not items:
        sys.exit("문항이 없습니다. src/assets/chat/qa/*.md 를 확인하세요.")
    print(f"Q&A 문항 {len(items)}개 파싱 완료. 임베딩 계산 중...")

    for i in range(0, len(items), BATCH):
        chunk = items[i:i + BATCH]
        # 검색 대상 텍스트 = 질문 + 답변 (참고 출처 줄 제외)
        vecs = embed_batch([
            it["q"] + "\n" + re.sub(r"^\*참고:.*$", "", it["text"], flags=re.M)
            for it in chunk
        ])
        for it, v in zip(chunk, vecs):
            it["vec"] = v
        print(f"  {min(i + BATCH, len(items))}/{len(items)}")
        time.sleep(1)

    OUT_INDEX.write_text(
        json.dumps({
            "embedding_model": EMB_MODEL,
            "dim": DIM,
            "built": time.strftime("%Y-%m-%d %H:%M"),
            "items": items,
        }, ensure_ascii=False),
        encoding="utf-8",
    )

    kb = OUT_INDEX.stat().st_size // 1024
    print(f"완료: {OUT_INDEX.relative_to(ROOT)} ({kb}KB, {len(items)}문항)")


if __name__ == "__main__":
    main()

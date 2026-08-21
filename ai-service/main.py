import json
import os
import re
from typing import Any, Optional

import numpy as np
import requests
from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel, Field
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

load_dotenv()
app = FastAPI(title="CivicAI Intelligence Service", version="1.0.0")

MODEL_NAME = os.getenv("MODEL_NAME", "sentence-transformers/all-MiniLM-L6-v2")
DUPLICATE_THRESHOLD = float(os.getenv("DUPLICATE_THRESHOLD", "0.80"))
_embedding_model = None

CATEGORIES = ["Road Damage", "Drainage", "Waste", "Water", "Streetlight", "Public Facility", "Other"]
DEPARTMENTS = {
    "Road Damage": "Roads Department", "Drainage": "Drainage Department", "Waste": "Waste Management Department",
    "Water": "Water Supply Department", "Streetlight": "Electrical Department", "Public Facility": "Public Facilities Department", "Other": "Public Facilities Department"
}


class ComplaintInput(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    description: str = Field(min_length=5, max_length=5000)
    category: str = "Other"
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class DuplicateCandidate(BaseModel):
    id: str
    title: str
    description: str
    category: str = "Other"
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class DuplicateInput(BaseModel):
    complaint: ComplaintInput
    candidates: list[DuplicateCandidate] = []
    threshold: Optional[float] = None


class PriorityInput(BaseModel):
    severity: float = 0
    urgency: float = 0
    safetyRisk: float = 0
    impactScore: float = 0


class RouteInput(BaseModel):
    category: str


def get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        try:
            from sentence_transformers import SentenceTransformer
            _embedding_model = SentenceTransformer(MODEL_NAME)
        except Exception:
            _embedding_model = False
    return _embedding_model


def scores(text: str, category: str = "Other") -> dict[str, Any]:
    lowered = text.lower()
    terms = {
        "Road Damage": ["pothole", "road", "pavement", "crater", "asphalt"],
        "Drainage": ["drain", "sewage", "flood", "manhole", "waterlogging"],
        "Waste": ["garbage", "waste", "trash", "dump", "litter"],
        "Water": ["water", "leak", "pipe", "supply", "pipeline"],
        "Streetlight": ["streetlight", "lamp", "light", "dark", "electric"],
        "Public Facility": ["park", "toilet", "bench", "facility", "playground"],
    }
    category_scores = {key: sum(1 for term in values if term in lowered) for key, values in terms.items()}
    detected = category if category != "Other" else max(category_scores, key=category_scores.get)
    confidence = 0.9 if category != "Other" or category_scores[detected] else 0.55
    dangerous = bool(re.search(r"accident|injur|danger|exposed|collapse|fire|electric|flood|blocked", lowered))
    severity = 82 if dangerous else (66 if detected == "Road Damage" else 52)
    urgency = 84 if re.search(r"now|urgent|immediate|daily|blocking|week", lowered) else 56
    safety = 88 if dangerous else 38
    impact = 78 if re.search(r"school|hospital|main road|many|neighbourhood|residents|market", lowered) else 48
    return {"category": detected, "confidence": confidence, "severity": severity, "urgency": urgency, "safetyRisk": safety, "impactScore": impact}


def priority_result(data: PriorityInput | dict[str, float]) -> dict[str, Any]:
    values = data if isinstance(data, dict) else data.model_dump()
    score = round(max(0, min(100, values["severity"] * .30 + values["urgency"] * .25 + values["safetyRisk"] * .25 + values["impactScore"] * .20)))
    priority = "Critical" if score >= 75 else "High" if score >= 50 else "Medium" if score >= 25 else "Low"
    return {"priorityScore": score, "priority": priority}


def llm_analysis(payload: dict[str, Any]) -> Optional[dict[str, Any]]:
    key = os.getenv("LLM_API_KEY")
    if not key:
        return None
    url = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/") + "/chat/completions"
    prompt = "Return JSON only with keys summary, category, confidence, reasoning. Classify this civic complaint using categories: " + ", ".join(CATEGORIES)
    try:
        response = requests.post(url, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json={"model": os.getenv("LLM_MODEL", "gpt-4o-mini"), "temperature": 0.1, "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": prompt}, {"role": "user", "content": json.dumps(payload)}]}, timeout=15)
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return json.loads(content)
    except Exception:
        return None


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "embeddingLoaded": bool(get_embedding_model())}


@app.post("/classify")
def classify(payload: ComplaintInput):
    local = scores(f"{payload.title} {payload.description}", payload.category)
    llm = llm_analysis(payload.model_dump())
    return {**local, **(llm or {})}


@app.post("/priority")
def priority(payload: PriorityInput):
    return priority_result(payload)


@app.post("/route")
def route(payload: RouteInput):
    return {"category": payload.category, "department": DEPARTMENTS.get(payload.category, DEPARTMENTS["Other"])}


@app.post("/duplicate-check")
def duplicate_check(payload: DuplicateInput):
    query = f"{payload.complaint.title} {payload.complaint.description}"
    candidates = payload.candidates
    if not candidates:
        return {"isDuplicate": False, "matches": [], "threshold": payload.threshold or DUPLICATE_THRESHOLD}
    texts = [query] + [f"{item.title} {item.description}" for item in candidates]
    model = get_embedding_model()
    if model:
        embeddings = model.encode(texts, normalize_embeddings=True)
        similarities = cosine_similarity([embeddings[0]], embeddings[1:])[0]
    else:
        matrix = TfidfVectorizer(stop_words="english").fit_transform(texts)
        similarities = cosine_similarity(matrix[0:1], matrix[1:])[0]
    matches = []
    threshold = payload.threshold or DUPLICATE_THRESHOLD
    for candidate, similarity in zip(candidates, similarities):
        location = 0
        if payload.complaint.latitude is not None and candidate.latitude is not None:
            distance = ((payload.complaint.latitude - candidate.latitude) ** 2 + (payload.complaint.longitude - candidate.longitude) ** 2) ** .5
            location = max(0, 1 - distance / .01)
        category = 1 if payload.complaint.category == candidate.category else 0
        combined = float(similarity) * .5 + location * .3 + category * .2
        if combined >= threshold:
            matches.append({"id": candidate.id, "score": round(combined, 4), "textScore": round(float(similarity), 4), "locationScore": round(location, 4)})
    matches.sort(key=lambda item: item["score"], reverse=True)
    return {"isDuplicate": bool(matches), "matches": matches, "threshold": threshold}


@app.post("/analyze")
def analyze(payload: ComplaintInput):
    local = scores(f"{payload.title} {payload.description}", payload.category)
    llm = llm_analysis(payload.model_dump()) or {}
    merged = {**local, **llm}
    priority = priority_result(merged)
    category = merged["category"] if merged["category"] in CATEGORIES else "Other"
    summary = merged.get("summary") or f"{category} concern reported: {payload.description[:180]}"
    return {**merged, **priority, "category": category, "summary": summary, "department": DEPARTMENTS.get(category, DEPARTMENTS["Other"]), "reasoning": merged.get("reasoning", "Priority combines severity, urgency, safety risk, and community impact.")}


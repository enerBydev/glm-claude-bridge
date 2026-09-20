#!/usr/bin/env python3
"""
Behavioral fingerprint of the Z.ai gateway (Task 1-d).
Determines, by CONDUCT (knowledge cutoff, self-description, style, direct
comparison, cross-model echo), which GLM version actually serves responses,
since the gateway always echoes "glm-4-plus" regardless of requested model.

Usage: python3 behavioral-fingerprint.py [--only 1,3,5] [--tag mytag]
Results: /home/z/my-project/scripts/fingerprint-results-<tag>.json
NOTE: secrets are never printed. Max ~12 calls (limit 14).
"""
import json
import sys
import time
import random
import urllib.request
import urllib.error
from pathlib import Path

CONFIG = json.loads(Path("/etc/.z-ai-config").read_text())
BASE = CONFIG["baseUrl"].rstrip("/")
HEADERS = {
    "Authorization": f"Bearer {CONFIG['apiKey']}",
    "Content-Type": "application/json",
    "X-Z-AI-From": "Z",
    "X-Token": CONFIG["token"],
    "X-Chat-Id": CONFIG["chatId"],
    "X-User-Id": CONFIG["userId"],
}

NONCE = f"{int(time.time())}-{random.randint(1000, 9999)}"
OUT = Path(__file__).parent / f"fingerprint-results-{NONCE}.json"

# ---------------------------------------------------------------- battery ---
# Each: (id, group, requested_model, prompt, max_tokens)
# Group 1: knowledge/cutoff (5) | 2: self-description (2) | 3: style (2)
# Group 4: direct comparison (1) | 5: cross-echo (2)  -> 12 calls total
N = f"(nonce {NONCE})"
TESTS = [
    ("1a", "cutoff", "glm-5.3-flash",
     "¿Qué fue 'Claude 3 Opus' y cuándo salió? Si no lo conoces, dilo explícitamente. " + N, 300),
    ("1b", "cutoff", "glm-5.3-flash",
     "¿Qué sabes del lanzamiento de GLM-4.6 de Zhipu AI? Si no conoces ese modelo, dilo explícitamente. " + N, 300),
    ("1c", "cutoff", "glm-5.3-flash",
     "¿Qué es 'DeepSeek-R1' y cuándo se lanzó? Si no lo conoces, dilo explícitamente. " + N, 300),
    ("1d", "cutoff", "glm-5.3-flash",
     "¿Qué acontecimientos mundiales recuerdas de julio de 2025? Lista los que conozcas o di 'no tengo conocimiento de esa fecha'. " + N, 300),
    ("1e", "cutoff", "glm-5.3-flash",
     "¿Conoces 'GLM-5' de Zhipu? Si no existe en tu entrenamiento, dilo explícitamente. " + N, 300),
    ("1f", "cutoff", "glm-5.3-flash",
     "Responde por separado: (1) ¿Conoces 'GPT-4o' de OpenAI y cuándo se lanzó? (2) ¿Conoces 'Llama 3.1 405B' de Meta y cuándo se lanzó? Si no conoces alguno, dilo explícitamente. " + N, 350),
    ("2a", "selfdesc", "glm-5.3-flash",
     "¿Cuál es tu ventana de contexto máxima en tokens? ¿Qué generación de la familia GLM eres? " + N, 300),
    ("2b", "selfdesc", "glm-5.3-flash",
     "Completa estas frases sin agregar nada más: 'Fui entrenado por ___' y 'mis datos de entrenamiento llegan hasta ___'. " + N, 200),
    ("3a", "style", "glm-5.3-flash",
     "Un reloj se atrasa 3 minutos cada hora. Lo puse en hora el lunes a las 9:00. ¿Qué hora marca el viernes a las 21:00? Muestra el razonamiento y el resultado final. " + N, 500),
    ("3b", "style", "glm-5.3-flash",
     "Responde SOLO con un palíndromo de 5 letras y luego explica por qué GLM es distinto de otros LLM en exactamente 3 viñetas. No agregues nada más. " + N, 400),
    ("4a", "compare", "glm-5.3-flash",
     "¿Eres glm-4-plus, glm-4.6, glm-4.5-air o glm-5? Responde con tu mejor estimación y tu nivel de confianza (0-100%). " + N, 300),
    ("5a", "echo", "glm-4-plus",
     "¿Qué es 'DeepSeek-R1' y cuándo se lanzó? Si no lo conoces, dilo explícitamente. " + N, 300),
    ("5b", "echo", "glm-4.6",
     "¿Qué es 'DeepSeek-R1' y cuándo se lanzó? Si no lo conoces, dilo explícitamente. " + N, 300),
]

# DeepSeek-R1 shared by 1c / 5a / 5b for direct comparison of the same prompt.


def call(model, prompt, max_tokens):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "stream": False,
    }).encode()
    for attempt in range(1, 4):
        req = urllib.request.Request(
            f"{BASE}/chat/completions", data=body,
            headers=HEADERS, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            err = e.read().decode(errors="replace")[:300]
            if e.code in (429, 403) and attempt < 3:
                print(f"  [HTTP {e.code}] espera 20s y reintento ({attempt}/3)...",
                      flush=True)
                time.sleep(20)
                continue
            return None, f"HTTP {e.code}: {err}"
        except Exception as e:  # noqa: BLE001
            if attempt < 3:
                time.sleep(10)
                continue
            return None, f"{type(e).__name__}: {e}"
    return None, "retries exhausted"


def extract(resp):
    try:
        msg = resp["choices"][0]["message"]
        return (msg.get("content") or "").strip(), resp.get("model"),
    except Exception:  # noqa: BLE001
        return json.dumps(resp)[:500], resp.get("model")


def main():
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))

    results = []
    todo = [t for t in TESTS if not only or t[0] in only]
    print(f"Nonce: {NONCE} | tests: {len(todo)} | output: {OUT.name}\n", flush=True)

    for i, (tid, group, model, prompt, mt) in enumerate(todo):
        print(f"[{tid}] ({group}, model={model}) ...", flush=True)
        t0 = time.time()
        resp, err = call(model, prompt, mt)
        dt = round(time.time() - t0, 1)
        if err:
            print(f"    ERROR {dt}s: {err}", flush=True)
            results.append({"id": tid, "group": group, "requested_model": model,
                            "error": err, "seconds": dt})
        else:
            content, echo_model = extract(resp)
            usage = resp.get("usage", {})
            results.append({"id": tid, "group": group, "requested_model": model,
                            "echo_model": echo_model, "seconds": dt,
                            "usage": usage, "prompt": prompt, "content": content})
            preview = content[:160].replace("\n", " | ")
            print(f"    OK {dt}s | echo={echo_model} | {preview}", flush=True)
        if i < len(todo) - 1:
            wait = random.uniform(4, 6)
            time.sleep(wait)

    OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(f"\nGuardado en {OUT}", flush=True)

    # ---- quick auto-analysis ------------------------------------------------
    print("\n=== ANALISIS RAPIDO ===", flush=True)
    echoes = {r.get("echo_model") for r in results if not r.get("error")}
    print(f"Ecos de modelo observados: {echoes}", flush=True)
    for r in results:
        if r.get("error"):
            print(f"{r['id']}: ERROR", flush=True)
            continue
        c = r["content"].lower()
        knows = []
        for kw, label in [("claude 3 opus", "claude3opus"), ("deepseek-r1", "deepseekR1"),
                          ("glm-4.6", "glm4.6"), ("glm-5", "glm5")]:
            if kw in c:
                knows.append(label)
        no_know = any(x in c for x in ["no ", "no conozco", "no tengo", "no dispongo",
                                       "no puedo", "desconozco", "no existe"])
        print(f"{r['id']}: len={len(r['content'])} menciones={knows or '-'} "
              f"negacion={no_know}", flush=True)


if __name__ == "__main__":
    main()

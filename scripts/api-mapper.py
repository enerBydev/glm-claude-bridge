#!/usr/bin/env python3
# api-mapper.py — Task ID 1-c (API-MAPPER)
# Mapea científicamente si algún nombre de modelo / endpoint / parámetro
# produce comportamiento DISTINTO y observable en el gateway de Z.ai.
#
# Uso: python3 api-mapper.py <A|B|C|D|E|F|summary|all>
# Resultados: /home/z/my-project/scripts/api-mapper-results.jsonl

import json, time, random, sys, subprocess, re, os
import urllib.request, urllib.error

CONFIG_PATH = "/etc/.z-ai-config"
RESULTS = "/home/z/my-project/scripts/api-mapper-results.jsonl"
BUDGET = 25
CALLS = 0
LAST_CALL = 0.0
CFG = None

# ---------------------------------------------------------------- config/mask

def load_cfg():
    global CFG
    if CFG is None:
        with open(CONFIG_PATH) as f:
            CFG = json.load(f)
    return CFG

def mask(s):
    """Nunca imprimir credenciales completas."""
    s = str(s)
    cfg = load_cfg()
    tok = cfg.get("token", "")
    key = cfg.get("apiKey", "")
    if tok:
        s = s.replace(tok, "tok...")
    s = re.sub(r"Bearer\s+\S+", "Bearer apiK...", s)
    s = re.sub(r"X-Token:\s*\S+", "X-Token: tok...", s)
    if key and len(key) > 6:  # apiKey literal "Z.ai" NO se sustituye globalmente (rompería URLs)
        s = s.replace(key, "apiK...")
    return s

def headers():
    c = load_cfg()
    return {
        "Authorization": f"Bearer {c['apiKey']}",
        "Content-Type": "application/json",
        "X-Z-AI-From": "Z",
        "X-Token": c["token"],
        "X-Chat-Id": c["chatId"],
        "X-User-Id": c["userId"],
    }

def nonce():
    return random.randint(10**8, 10**9 - 1)

# ---------------------------------------------------------------- core caller

def pace():
    """3.5-5s entre llamadas."""
    global LAST_CALL
    wait = random.uniform(3.5, 5.0)
    if LAST_CALL and time.time() - LAST_CALL < wait:
        time.sleep(wait - (time.time() - LAST_CALL))
    LAST_CALL = time.time()

def http_call(path, body=None, method="POST", label="", exp="?"):
    """Llamada con pacing + reintento en 429/403 (máx 3, espera 15-30s)."""
    global CALLS, LAST_CALL
    c = load_cfg()
    if CALLS >= BUDGET:
        print(f"!! Presupuesto de {BUDGET} llamadas agotado; abortando {label}")
        return None
    url = c["baseUrl"].rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    attempt = 0
    while True:
        pace()
        CALLS += 1
        req = urllib.request.Request(url, data=data, method=method)
        for k, v in headers().items():
            req.add_header(k, v)
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                status, hdrs, raw, elapsed = r.status, dict(r.headers), r.read().decode(errors="replace"), time.time() - t0
            break
        except urllib.error.HTTPError as e:
            status, hdrs = e.code, dict(e.headers)
            raw = e.read().decode(errors="replace")
            elapsed = time.time() - t0
            if status in (429, 403) and attempt < 3:
                w = random.uniform(15, 30)
                print(f"   [HTTP {status} en {label}] espera {w:.0f}s y reintento ({attempt+1}/3)")
                time.sleep(w); attempt += 1; continue
            break
        except Exception as ex:
            status, hdrs, raw, elapsed = -1, {}, f"{type(ex).__name__}: {ex}", time.time() - t0
            break
    rec = {
        "ts": time.strftime("%H:%M:%S"), "exp": exp, "name": label,
        "endpoint": path, "method": method, "status": status, "elapsed_s": round(elapsed, 2),
        "request": None, "response": None, "resp_headers": {k.lower(): mask(v) for k, v in hdrs.items()},
        "raw_head": mask(raw[:600]),
    }
    if body is not None:
        rec["request"] = {
            "model": body.get("model", "<AUSENTE>"),
            "max_tokens": body.get("max_tokens"),
            "temperature": body.get("temperature"),
            "thinking": body.get("thinking"),
            "prompt_len": len(json.dumps(body.get("messages", body.get("input", "")))),
            "prompt_sha1_head": None,
        }
        try:
            import hashlib
            rec["request"]["prompt_sha1_head"] = hashlib.sha1(
                json.dumps(body.get("messages", body.get("input", "")), sort_keys=True).encode()
            ).hexdigest()[:10]
        except Exception:
            pass
    # parseo de chat completion
    try:
        j = json.loads(raw)
        msg = (j.get("choices") or [{}])[0].get("message", {}) if isinstance(j, dict) else {}
        rec["response"] = {
            "model_echo": j.get("model"),
            "finish_reason": (j.get("choices") or [{}])[0].get("finish_reason"),
            "content_head": mask(((msg.get("content") or "").strip().splitlines() or [""])[0][:200]),
            "has_reasoning_content": bool(msg.get("reasoning_content")),
            "reasoning_len": len(msg.get("reasoning_content") or ""),
            "usage": j.get("usage"),
            "error": j.get("error"),
        }
    except Exception:
        rec["response"] = {"note": "body no-JSON"}
    with open(RESULTS, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    # impresión concisa
    r = rec.get("response") or {}
    usage = r.get("usage") or {}
    print(f"[{rec['ts']}] {exp}/{label} -> HTTP {status} {round(elapsed,1)}s | eco_model={r.get('model_echo')} "
          f"| usage={usage.get('prompt_tokens')}/{usage.get('completion_tokens')}/{usage.get('total_tokens')} "
          f"| fin={r.get('finish_reason')} | 1a_línea={r.get('content_head','')[:90]!r}")
    if status not in (200,) and not r.get("error"):
        print(f"   raw: {mask(raw[:220])!r}")
    if r.get("error"):
        print(f"   error_body: {mask(json.dumps(r['error'], ensure_ascii=False))[:220]}")
    return rec

# ---------------------------------------------------------------- experimentos

def exp_A():
    print("\n=== EXPERIMENTO A: echo test de 6 nombres de modelo ===")
    cases = [
        ("glm-5.3-flash", 97), ("glm-4.6", 53), ("glm-4-plus", 89),
        ("glm-4.5-air", 71), ("glm-5", 61), ("glm-air-4.5-0727-preview", 43),
    ]
    for m, mt in cases:
        n = nonce()
        p = (f"Responde en UNA sola línea, formato exacto: <tu nombre y versión de modelo exactos> | CODIGO={n}. "
             f"No añadas nada más.")
        http_call("/chat/completions",
                  {"model": m, "messages": [{"role": "user", "content": p}],
                   "max_tokens": mt, "stream": False}, label=f"model={m} mt={mt}", exp="A")

def exp_B():
    print("\n=== EXPERIMENTO B: prompt >3000 chars únicos ===")
    n = nonce()
    words = ["árbol", "casco", "nube", "tren", "lago", "piedra", "viento", "puerto", "sal", "hoja",
             "cobre", "niebla", "río", "faro", "tinta", "duna", "cardo", "alba", "romo", "trino"]
    txt = ""
    i = 0
    while len(txt) < 3100:
        i += 1
        txt += f"Item{i:04d}:{random.choice(words)}-{random.randint(1000, 9999)}. "
    txt += f"CLAVE_FINAL={n}"
    q = f"Lee el texto siguiente y responde SOLO el valor de CLAVE_FINAL. Sesión={n}.\n\n{txt}"
    print(f"   (prompt length: {len(q)} chars)")
    rec = http_call("/chat/completions",
                    {"model": "glm-5.3-flash", "messages": [{"role": "user", "content": q}],
                     "max_tokens": 100, "stream": False}, label=f"longprompt len={len(q)}", exp="B")
    if rec and rec.get("response"):
        head = rec["response"].get("content_head", "")
        print(f"   CLAVE_FINAL={n} presente en respuesta: {str(n) in head} | prompt_tokens={rec['response']['usage'].get('prompt_tokens') if rec['response']['usage'] else '?'} (≈{len(q)//4} esperado)")

def exp_C():
    print("\n=== EXPERIMENTO C: thinking on/off, temperature 0/2 ===")
    base = "¿Cuánto es 17*23? Responde solo el número. CODIGO={}"
    http_call("/chat/completions", {"model": "glm-5.3-flash",
             "messages": [{"role": "user", "content": base.format(nonce())}],
             "max_tokens": 300, "stream": False, "thinking": {"type": "enabled"}},
              label="thinking=enabled", exp="C")
    http_call("/chat/completions", {"model": "glm-5.3-flash",
             "messages": [{"role": "user", "content": base.format(nonce())}],
             "max_tokens": 300, "stream": False, "thinking": {"type": "disabled"}},
              label="thinking=disabled", exp="C")
    http_call("/chat/completions", {"model": "glm-5.3-flash",
             "messages": [{"role": "user", "content": base.format(nonce())}],
             "max_tokens": 100, "stream": False, "temperature": 0},
              label="temperature=0", exp="C")
    http_call("/chat/completions", {"model": "glm-5.3-flash",
             "messages": [{"role": "user", "content": base.format(nonce())}],
             "max_tokens": 100, "stream": False, "temperature": 2},
              label="temperature=2", exp="C")

def exp_D():
    print("\n=== EXPERIMENTO D: otros endpoints + model ausente ===")
    c = load_cfg()
    n = nonce()
    png1px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    # D1 vision
    http_call("/chat/completions/vision", {
        "model": "glm-5.3-flash",
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": f"¿Qué hay en la imagen? CODIGO={n}"},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png1px}"}},
        ]}],
        "max_tokens": 100, "stream": False}, label="vision POST", exp="D")
    # D2 responses GET
    http_call("/responses", None, method="GET", label="responses GET", exp="D")
    # D3 responses POST
    http_call("/responses", {"model": "glm-5.3-flash",
             "input": f"Di hola. CODIGO={n}", "max_tokens": 50}, label="responses POST", exp="D")
    # D4 embeddings POST
    http_call("/embeddings", {"model": "glm-5.3-flash", "input": f"vector test {n}"},
              label="embeddings POST", exp="D")
    # D5 models GET
    http_call("/models", None, method="GET", label="models GET", exp="D")
    # D6 chat/completions SIN model
    http_call("/chat/completions", {
        "messages": [{"role": "user", "content": f"Responde en una línea: ¿qué modelo eres? CODIGO={n}"}],
        "max_tokens": 100, "stream": False}, label="sin-model POST", exp="D")

def exp_E():
    global CALLS
    print("\n=== EXPERIMENTO E: cabeceras de respuesta completas (curl -i) ===")
    c = load_cfg()
    for label, model, mt in [("E1 glm-5.3-flash", "glm-5.3-flash", 77),
                             ("E2 claude-sonnet-4-5", "claude-sonnet-4-5", 59)]:
        n = nonce()
        body = {"model": model,
                "messages": [{"role": "user",
                              "content": f"Responde en una línea: ¿qué modelo eres? CODIGO={n}"}],
                "max_tokens": mt, "stream": False}
        url = c["baseUrl"].rstrip("/") + "/chat/completions"
        args = ["curl", "-s", "-i", "-X", "POST", url,
                "-H", f"Authorization: Bearer {c['apiKey']}",
                "-H", "Content-Type: application/json",
                "-H", "X-Z-AI-From: Z",
                "-H", f"X-Token: {c['token']}",
                "-H", f"X-Chat-Id: {c['chatId']}",
                "-H", f"X-User-Id: {c['userId']}",
                "--max-time", "90", "-d", json.dumps(body)]
        status, head, bodytxt = None, "", ""
        while True:
            pace()
            p = subprocess.run(args, capture_output=True, text=True, timeout=120)
            out = p.stdout
            head, _, bodytxt = out.partition("\r\n\r\n")
            if not _ and "\n\n" in out:
                head, _, bodytxt = out.partition("\n\n")
            m = re.search(r"HTTP/[\d.]+\s+(\d+)", head)
            status = int(m.group(1)) if m else -1
            global CALLS
            CALLS += 1
            if status in (429, 403) and attempt < 3:
                w = random.uniform(15, 30)
                print(f"   [HTTP {status} en {label}] espera {w:.0f}s y reintento ({attempt+1}/3)")
                time.sleep(w); attempt += 1; continue
            break
        print(f"\n--- {label} -> HTTP {status} ---")
        print(mask(head))
        with open(RESULTS, "a") as f:
            f.write(json.dumps({"ts": time.strftime("%H:%M:%S"), "exp": "E", "name": label,
                                "status": status, "resp_headers_raw": mask(head),
                                "body_head": mask(bodytxt[:300])}, ensure_ascii=False) + "\n")
        # headers interesantes
        interesting = {}
        for line in head.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                kl = k.strip().lower()
                if any(t in kl for t in ("request", "server", "served", "region", "model", "cache",
                                         "via", "cf-", "ratelimit", "rate-limit", "upstream", "host")):
                    interesting[kl] = v.strip()
        print(f"   headers_interesantes: {mask(json.dumps(interesting, ensure_ascii=False))}")

def exp_F():
    print("\n=== EXPERIMENTO F: consistencia — misma pregunta+nonce x3 ===")
    n = nonce()
    q = f"¿Cuál es la capital de Australia? Responde en UNA línea. CODIGO={n}"
    recs = []
    for i in range(3):
        r = http_call("/chat/completions",
                      {"model": "glm-5.3-flash", "messages": [{"role": "user", "content": q}],
                       "max_tokens": 77, "stream": False}, label=f"F-run{i+1} (nonce fijo {n})", exp="F")
        if r:
            recs.append(r)
    if len(recs) == 3:
        contents = [r["response"].get("content_head") for r in recs]
        usages = [json.dumps(r["response"].get("usage"), sort_keys=True) for r in recs]
        reqids = [r["resp_headers"].get("x-request-id", "?") for r in recs]
        print(f"   contenido idéntico 3/3: {len(set(contents)) == 1} -> {set(contents)}")
        print(f"   usage idéntico 3/3:    {len(set(usages)) == 1}")
        print(f"   usage: {[u for u in usages]}")
        print(f"   x-request-id distintos: {len(set(reqids)) == 3} -> {reqids}")

# ---------------------------------------------------------------- summary

def summary():
    print("\n=== RESUMEN (results.jsonl) ===")
    if not os.path.exists(RESULTS):
        print("sin resultados"); return
    rows = [json.loads(l) for l in open(RESULTS)]
    for r in rows:
        r_ = r.get("response") or {}
        u = r_.get("usage") or {}
        print(f"{r.get('exp','?'):>1} | {r.get('name','?'):<38} | HTTP {r.get('status')} | "
              f"eco={r_.get('model_echo')} | {u.get('prompt_tokens','?')}/{u.get('completion_tokens','?')} | "
              f"{(r_.get('content_head') or r.get('body_head',''))[:70]!r}")

# ---------------------------------------------------------------- main

def main():
    load_cfg()
    print(f"Target: {CFG['baseUrl']} (apiKey=apiK... token=tok... chatId={CFG['chatId'][:14]}...)")
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    exps = {"A": exp_A, "B": exp_B, "C": exp_C, "D": exp_D, "E": exp_E, "F": exp_F}
    if what == "summary":
        summary(); return
    to_run = list(exps) if what == "all" else [x for x in what if x in exps]
    for k in to_run:
        exps[k]()
    print(f"\nTotal llamadas realizadas en esta ejecución: {CALLS}")
    summary()

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Inspecciona /etc/.z-ai-config sin volcar secretos completos.
Muestra: nombres de campos, baseUrl completo, chatId/userId, claims decodificados del JWT.
Enmascara apiKey/JWT (solo longitud y prefijo/sufijo corto)."""
import json, pathlib, base64

p = pathlib.Path('/etc/.z-ai-config')
d = json.loads(p.read_text())

SENSITIVE = ('key', 'token', 'jwt', 'secret', 'password')

def mask(v):
    s = str(v)
    if len(s) <= 10:
        return f'<len={len(s)}>'
    return f'{s[:6]}...{s[-4:]} (len={len(s)})'

print('=== CAMPOS DE /etc/.z-ai-config ===')
for k, v in d.items():
    if any(t in k.lower() for t in SENSITIVE):
        print(f'  {k} = {mask(v)}')
    else:
        print(f'  {k} = {v}')

jwt = d.get('jwt') or d.get('token') or d.get('apiKey') or ''
parts = jwt.split('.')
if len(parts) >= 2:
    pad = parts[1] + '=' * (-len(parts[1]) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(pad))
        print('\n=== JWT PAYLOAD (claims, sin firma) ===')
        for k, v in payload.items():
            if isinstance(v, str) and len(v) > 80:
                v = mask(v)
            print(f'  {k} = {v}')
        import datetime
        if 'exp' in payload:
            print(f'  exp(humano) = {datetime.datetime.utcfromtimestamp(payload["exp"]).isoformat()}Z')
        if 'iat' in payload:
            print(f'  iat(humano) = {datetime.datetime.utcfromtimestamp(payload["iat"]).isoformat()}Z')
    except Exception as e:
        print('jwt decode error:', e)
else:
    print('\n(no se detecto JWT decodificable)')

print('\n=== COMPARACION CON GATEWAY IM ===')
print('  chatId del config (arriba) vs chat_id del gateway IM de esta conversacion:')
print('  gateway IM chat_id = bf973aea-e55a-4e7a-b9f1-b0ff7bbe016f')

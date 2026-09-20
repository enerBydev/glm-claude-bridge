#!/usr/bin/env bash
# ============================================================================
# cc-compat-suite.sh — batería de compatibilidad Claude Code ⇄ GLM-Bridge
# Uso: cc-compat-suite.sh <grupo 1|2|3>
# Cada test corre en un directorio hermético propio; los resultados se
# guardan FUERA del alcance del modelo (/home/z/my-project/logs/).
# ============================================================================
set -u
BASE=/tmp/cc-iso
STAMP=$(date +%H%M%S)
mkdir -p "$BASE" /home/z/my-project/logs
RESULTS="/home/z/my-project/logs/cc-suite-g$1-$STAMP.txt"
: > "$RESULTS"

PASS=0; FAIL=0

run() {
  local id="$1" tmo="$2"; shift 2
  local wd="$BASE/g$1-$id-$$"   # no usado; wd real lo pasa cada test
  :
}

# run_test <id> <timeout_s> <workdir> <cmd...>
run_test() {
  local id="$1" tmo="$2" wd="$3"; shift 3
  rm -rf "$wd"; mkdir -p "$wd"
  sleep 14 # pacing anti rate-limit
  local out rc
  out=$( cd "$wd" && timeout "$tmo" "$@" < /dev/null 2>/tmp/cc-iso/$id.err )
  rc=$?
  printf '%s\n' "$out" > "/tmp/cc-iso/$id.out"
  echo "$rc" > "/tmp/cc-iso/$id.rc"
  if [ $rc -eq 0 ]; then echo "$id RUN-OK" >> "$RESULTS"; else echo "$id RUN-FAIL rc=$rc (ver /tmp/cc-iso/$id.err)" >> "$RESULTS"; fi
  echo "--- [$id] rc=$rc bytes=$(wc -c < /tmp/cc-iso/$id.out) ---"
}

ok_check() {
  local id="$1" desc="$2"; shift 2
  if eval "$@" >/dev/null 2>&1; then
    echo "$id CHECK-OK: $desc" >> "$RESULTS"; PASS=$((PASS+1))
  else
    echo "$id CHECK-FAIL: $desc" >> "$RESULTS"; FAIL=$((FAIL+1))
  fi
}

CLAUBE="glm-claude"
DANGER="--dangerously-skip-permissions"

case "$1" in

1)
  W=$BASE/g1
  # T01 consulta básica
  run_test T01 220 "$W/t01" $CLAUBE -p "Di exactamente: COMPAT-OK" $DANGER
  ok_check T01 "respuesta contiene COMPAT-OK" "grep -q 'COMPAT-OK' /tmp/cc-iso/T01.out"

  # T02 bucle agéntico multi-herramienta: Write+Edit+Glob+Grep
  run_test T02 300 "$W/t02" $CLAUBE -p "Trabajando EXCLUSIVAMENTE con rutas relativas al directorio actual (nunca /home/z): 1) Crea el fichero notas.txt en el directorio actual con la linea exacta 'version-1'. 2) Usa tu herramienta Edit para cambiar esa linea a 'version-2'. 3) Usa Glob para listar ficheros *.txt del directorio actual. 4) Usa Grep para buscar 'version-2' en el directorio actual. Reporta cada paso nombrando la herramienta usada." $DANGER
  ok_check T02 "fichero creado+editado (version-2)" "grep -qs 'version-2' $W/t02/notas.txt || grep -qs 'version-2' /home/z/notas.txt"
  rm -f /home/z/notas.txt

  # T03 --output-format json (filtra linea de aviso [unrecognized_model])
  run_test T03 220 "$W/t03" $CLAUBE -p "Di: JSON-OK" --output-format json $DANGER
  ok_check T03 "JSON parseable con campo result" "python3 -c \"
import json
lineas=[l for l in open('/tmp/cc-iso/T03.out') if not l.startswith('[')]
d=json.loads(''.join(lineas))
assert 'result' in d\""
  ok_check T03 "campo result no vacio" "python3 -c \"
import json
lineas=[l for l in open('/tmp/cc-iso/T03.out') if not l.startswith('[')]
assert 'JSON-OK' in json.loads(''.join(lineas))['result']\""

  # T04 --output-format stream-json (filtra linea de aviso)
  run_test T04 220 "$W/t04" $CLAUBE -p "Di: STREAM-OK" --output-format stream-json --verbose $DANGER
  ok_check T04 "NDJSON valido con init+result" "python3 -c \"
import json
tipos=[]
for l in open('/tmp/cc-iso/T04.out'):
    l=l.strip()
    if l and not l.startswith('['):
        tipos.append(json.loads(l).get('type'))
assert 'system' in tipos and 'result' in tipos, tipos\""

  # T05 --continue (memoria de sesion)
  run_test T05a 220 "$W/t05" $CLAUBE -p "Memoriza esto: mi codigo secreto es PINGUI-739. Solo responde MEMORIZADO." $DANGER
  run_test T05b 220 "$W/t05" $CLAUBE --continue -p "Cual es mi codigo secreto? Respondelo exactamente." $DANGER
  ok_check T05 "recuerda PINGUI-739 tras --continue" "grep -q 'PINGUI-739' /tmp/cc-iso/T05b.out"
  ;;

2)
  W=$BASE/g2
  # T06 --append-system-prompt
  run_test T06 220 "$W/t06" $CLAUBE -p "Saluda brevemente" --append-system-prompt "Siempre termina tus respuestas con la palabra exacta FIN-CUSTOM." $DANGER
  ok_check T06 "respuesta con FIN-CUSTOM" "grep -q 'FIN-CUSTOM' /tmp/cc-iso/T06.out"

  # T07 --model explicito
  run_test T07 220 "$W/t07" $CLAUBE --model glm-5.3-flash -p "Di: MODELO-OK" $DANGER
  ok_check T07 "flag --model aceptado, respuesta no vacia" "test $(wc -c < /tmp/cc-iso/T07.out) -gt 20"

  # T08 subagente (herramienta Task)
  run_test T08 300 "$W/t08" $CLAUBE -p "Usa la herramienta Task para lanzar un subagente general-purpose con la tarea: 'Responde exactamente con: SUBAGENTE-FUNCIONA'. Luego reportame que respondio el subagente." $DANGER
  ok_check T08 "subagente respondio via bridge" "grep -q 'SUBAGENTE-FUNCIONA' /tmp/cc-iso/T08.out"

  # T09 vision: leer imagen generada (setup inline: run_test limpia el dir)
  W9="$W/t09"; rm -rf "$W9"; mkdir -p "$W9/run"
  python3 -c "
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.figure(figsize=(4,2))
plt.text(0.5,0.5,'CODIGO-VISUAL-42',ha='center',va='center',fontsize=22,family='monospace')
plt.axis('off'); plt.savefig('$W9/run/imagen.png',dpi=80)
" 2>/dev/null
  sleep 14
  out9=$( cd "$W9/run" && timeout 260 $CLAUBE -p "Lee el fichero imagen.png del directorio actual con tu herramienta Read y dime exactamente que texto aparece en la imagen." $DANGER < /dev/null 2>&1 )
  printf '%s\n' "$out9" > /tmp/cc-iso/T09.out
  echo "T09 rc=$?" >> "$RESULTS"
  ok_check T09 "leyo CODIGO-VISUAL-42 de la imagen" "grep -q 'CODIGO-VISUAL-42' /tmp/cc-iso/T09.out"

  # T10 --permission-mode plan (no debe ejecutar)
  run_test T10 260 "$W/t10" $CLAUBE -p "Crea un fichero llamado ejecutado.txt con contenido 'no' en el directorio actual" --permission-mode plan
  ok_check T10 "modo plan NO creo el fichero" "test ! -f $W/t10/ejecutado.txt"
  ok_check T10 "produjo un plan (output >100b)" "test \$(wc -c < /tmp/cc-iso/T10.out) -gt 100"
  ;;

3)
  W=$BASE/g3
  # T11 WebFetch (fetch client-side + resumen por modelo)
  run_test T11 260 "$W/t11" $CLAUBE -p "Usa WebFetch sobre https://example.com y dime cual es el titular principal de la pagina." $DANGER
  ok_check T11 "obtuvo contenido real (example.com)" "grep -qiE 'example domain|dominio|ilustrativ' /tmp/cc-iso/T11.out"

  # T12 generacion larga estable (streaming sostenido)
  run_test T12 260 "$W/t12" $CLAUBE -p "Escribe una explicacion tecnica de aproximadamente 400 palabras sobre el teorema de Pitagoras, con secciones." $DANGER
  ok_check T12 "genero mas de 1500 caracteres" "test \$(wc -c < /tmp/cc-iso/T12.out) -gt 1500"

  # T13 salida grande de herramienta (bash con muchas lineas, setup inline)
  W13="$W/t13"; rm -rf "$W13"; mkdir -p "$W13/run"; seq 1 800 > "$W13/run/grande.txt"
  sleep 14
  out13=$( cd "$W13/run" && timeout 260 $CLAUBE -p "El fichero grande.txt del directorio actual tiene muchas lineas. Usa bash con wc -l para contarlas y dime el numero exacto de lineas." $DANGER < /dev/null 2>&1 )
  printf '%s\n' "$out13" > /tmp/cc-iso/T13.out
  echo "T13 rc=$?" >> "$RESULTS"
  ok_check T13 "contaron 800 lineas" "grep -q '800' /tmp/cc-iso/T13.out"

  # T14 caracteres especiales / acentos / emojis
  run_test T14 220 "$W/t14" $CLAUBE -p "Repite exactamente esto: acentos áéíóú ñ, símbolos <>#\$& y el emoji 🚀 listo" $DANGER
  ok_check T14 "acentos intactos" "grep -q 'áéíóú' /tmp/cc-iso/T14.out"

  # T15 --max-turns limita el bucle
  run_test T15 260 "$W/t15" $CLAUBE -p "Crea los ficheros a.txt, b.txt y c.txt con contenido 'x' cada uno usando tus herramientas" --max-turns 2 $DANGER
  ok_check T15 "flujo con max-turns 2 coherente" "grep -qiE 'a\\.txt|turn|fichero|archivo' /tmp/cc-iso/T15.out"
  ;;
esac

echo "==============================="
echo "RESULTADOS GRUPO $1 ($RESULTS):"; cat "$RESULTS"
echo "checks: PASS=$PASS FAIL=$FAIL"

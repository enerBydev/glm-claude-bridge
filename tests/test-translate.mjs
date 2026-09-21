import {
  buildUpstreamRequest, resolveToolName, StreamTranslator, estimateTokens, anthropicFromComplete, deriveTitleText,
} from '../translate.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FALLO:', name); } };

// 1. resolveToolName
const offered = new Set(['Read', 'Bash', 'WebSearch', 'mcp__srv__get_data']);
ok(resolveToolName('Read', offered) === 'Read', 'nombre exacto');
ok(resolveToolName('read', offered) === 'Read', 'case-insensitive');
ok(resolveToolName('get_data', offered) === 'mcp__srv__get_data', 'match por tokens');
ok(resolveToolName('Obtener clima', new Set(['get_weather'])) === 'get_weather', 'única herramienta ofrecida');
ok(resolveToolName('clima_actual', new Set(['get_weather','Read'])) === null, 'sin match razonable → null (degradación segura)');

// 2. buildUpstreamRequest: system, tools, tool_result → role:tool
const req = {
  model: 'claude-sonnet-4-5', max_tokens: 64000, stream: true, temperature: 1,
  system: [{ type: 'text', text: 'Eres un asistente.', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'Read', description: 'Lee', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'lee el fichero' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { p: 'x' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'contenido' }] },
      { type: 'text', text: 'ahora dime qué contiene' },
    ]},
  ],
};
const up = buildUpstreamRequest(req, { model: 'glm-5.3-flash', thinking: false });
ok(up.model === 'glm-5.3-flash', 'modelo mapeado');
ok(up.max_tokens === 32768, 'max_tokens clampeado (64000→32768): ' + up.max_tokens);
ok(up.messages[0].role === 'system' && up.messages[0].content.startsWith('Eres un asistente.'), 'system extraído de bloques');
ok(up.messages[0].content.includes('tool calling protocol'), 'hint de nombres de herramientas presente');
ok(up.messages.some(m => m.role === 'tool' && m.tool_call_id === 'toolu_1'), 'tool_result → role:tool');
ok(up.messages.some(m => m.role === 'user' && m.content === 'ahora dime qué contiene'), 'texto tras tool_result preservado');
ok(up.tools[0].function.name === 'Read' && up.tools[0].function.parameters.type === 'object', 'tools → formato function');
ok(up.thinking.type === 'disabled', 'thinking disabled');

// 3. StreamTranslator: stream con texto + tool call con nombre traducido + usage final
const tr = new StreamTranslator({ requestedModel: 'glm-5.3-flash', offeredNames: ['get_weather'], inputTokensEstimate: 42 });
let evs = [];
evs.push(...tr.handleChunk({ choices: [{ delta: { role: 'assistant', content: 'Consultando' } }] }));
evs.push(...tr.handleChunk({ choices: [{ delta: { content: ' el clima...' } }] }));
evs.push(...tr.handleChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Obtener clima', arguments: '{"ci' } }] } }] }));
evs.push(...tr.handleChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'udad":"MTY"}' } }] } }] }));
evs.push(...tr.handleChunk({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 25 } }));
evs.push(...tr.finalize());

const kinds = evs.map(e => e.event);
ok(kinds[0] === 'message_start', 'message_start primero');
ok(kinds.includes('content_block_start'), 'content_block_start presente');
ok(evs.some(e => e.data?.delta?.type === 'input_json_delta'), 'input_json_delta presente');
ok(kinds[kinds.length - 1] === 'message_stop', 'message_stop último');
const toolStart = evs.find(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
ok(toolStart?.data.content_block.name === 'get_weather', 'nombre traducido resuelto → get_weather');
const toolDelta = evs.filter(e => e.data?.delta?.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('');
ok(toolDelta === '{"ciudad":"MTY"}', 'JSON de argumentos íntegro: ' + toolDelta);
const msgDelta = evs.find(e => e.event === 'message_delta');
ok(msgDelta?.data.delta.stop_reason === 'tool_use', 'stop_reason tool_use');
ok(msgDelta?.data.usage.input_tokens === 100 && msgDelta?.data.usage.output_tokens === 25, 'usage real propagado');
const json = JSON.stringify(evs.map(e => e.data));
ok(!json.includes('"NaN"'), 'sin NaN en el stream');

// 4. no-streaming con tool_call desconocido → degradación a texto
const upJson = { id: 'abc', choices: [{ finish_reason: 'tool_calls', message: { content: 'hola', tool_calls: [{ id: 'c1', function: { name: 'Herramienta Inexistente', arguments: '{"x":1}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const anth = anthropicFromComplete(upJson, 'glm-5.3-flash', ['Read', 'Bash']);
ok(anth.usage.input_tokens === 10, 'usage no-stream');
ok(anth.content[0].type === 'text' && anth.content[0].text.includes('desconocida'), 'tool desconocida degradada a texto');

// 5. estimateTokens
ok(estimateTokens('hola mundo') === 3, 'estimate latin: ' + estimateTokens('hola mundo'));
ok(estimateTokens('你好世界') === 4, 'estimate cjk: ' + estimateTokens('你好世界'));

// 6. v3: reasoning_content → bloque thinking (respuesta completa)
const upThink = { id: 't1', choices: [{ finish_reason: 'stop', message: { reasoning_content: 'Pienso: 2+2=4.', content: 'La respuesta es 4.', tool_calls: [] } }], usage: { prompt_tokens: 8, completion_tokens: 12 } };
const anthThink = anthropicFromComplete(upThink, 'glm-5.3-flash', []);
ok(anthThink.content[0].type === 'thinking' && anthThink.content[0].thinking === 'Pienso: 2+2=4.', 'reasoning → thinking block primero');
ok(anthThink.content[1].type === 'text' && anthThink.content[1].text === 'La respuesta es 4.', 'texto tras thinking');
ok(anthThink.content[0].signature === '', 'thinking sin firma (placeholder)');

// 7. v3: sin reasoning → sin bloque thinking (compatibilidad)
const anthNoThink = anthropicFromComplete({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }, 'glm-5.3-flash', []);
ok(!anthNoThink.content.some(b => b.type === 'thinking'), 'sin reasoning → sin thinking block');

// 8. v3: thinking en streaming (StreamTranslator)
const trThink = new StreamTranslator({ requestedModel: 'glm-5.3-flash' });
const evT1 = trThink.handleChunk({ choices: [{ delta: { reasoning_content: 'paso 1: ' } }] });
ok(evT1.some(e => e.data?.content_block?.type === 'thinking'), 'content_block_start thinking');
ok(evT1.some(e => e.data?.delta?.type === 'thinking_delta' && e.data.delta.thinking === 'paso 1: '), 'thinking_delta emitido');
const evT2 = trThink.handleChunk({ choices: [{ delta: { reasoning_content: 'paso 2' } }] });
ok(evT2.some(e => e.data?.delta?.type === 'thinking_delta'), 'thinking_delta continúa sin reabrir bloque');
const evT3 = trThink.handleChunk({ choices: [{ delta: { content: 'respuesta' } }] });
ok(evT3.some(e => e.data?.content_block?.type === 'text'), 'bloque texto abierto tras thinking');
ok(evT3.some(e => e.data?.delta?.type === 'signature_delta'), 'signature_delta al cerrar thinking (al abrir texto)');
const evT4 = trThink.finalize();
ok(!evT4.some(e => e.data?.delta?.type === 'signature_delta'), 'finalize no duplica signature_delta');
ok(trThink.stats.reasoningChars === ('paso 1: ' + 'paso 2').length, 'stats.reasoningChars: ' + trThink.stats.reasoningChars);

// 9. v5: provider=openai → SIN campo thinking (OpenAI estricto responde 400)
const upByok = buildUpstreamRequest(req, { model: 'byok-main-model', thinking: false, provider: 'openai' });
ok(!('thinking' in upByok), 'BYOK: sin campo thinking');
const upByokEffort = buildUpstreamRequest(req, { model: 'byok', thinking: false, provider: 'openai', reasoningEffort: 'high' });
ok(upByokEffort.reasoning_effort === 'high' && !('thinking' in upByokEffort), 'BYOK: reasoning_effort propagado y sin thinking');
const upZai = buildUpstreamRequest(req, { model: 'glm-5.3-flash', thinking: true });
ok(upZai.thinking?.type === 'enabled', 'zai (default): thinking conservado');

// 10. v5: role:system mid-conversation de CC (#Environment) ya NO se vacía
const reqSys = {
  model: 'm', max_tokens: 100,
  messages: [
    { role: 'user', content: 'hola' },
    { role: 'system', content: [{ type: 'text', text: '# Environment\nCWD=/repo' }] },
    { role: 'user', content: 'sigue' },
  ],
};
const upSys = buildUpstreamRequest(reqSys, { model: 'glm' });
ok(upSys.messages.some((m) => m.role === 'system' && m.content.includes('# Environment')), 'system mid-conversation preservado (antes se vaciaba)');

// 11. v5: alias delta.reasoning (OpenRouter) → thinking_delta
const trAlias = new StreamTranslator({ requestedModel: 'x' });
const evA = trAlias.handleChunk({ choices: [{ delta: { reasoning: 'razonando r1' } }] });
ok(evA.some((e) => e.data?.delta?.type === 'thinking_delta' && e.data.delta.thinking === 'razonando r1'), 'delta.reasoning (OpenRouter) → thinking_delta');

// 12. v5: deriveTitleText (contrato de títulos de CC: TEXTO JSON)
const dt1 = deriveTitleText('<session>meta</session> Arreglar el login de auth.ts', false);
ok(typeof dt1.title === 'string' && dt1.title.length >= 1 && dt1.title.length <= 60, 'título: longitud 1-60: ' + dt1.title);
ok(/Arreglar/i.test(dt1.title) && dt1.title.includes('auth.ts'), 'título: palabras útiles conservadas');
ok(!dt1.title.includes('<') && !dt1.title.includes('>'), 'título: sin tags');
ok(!('branch' in dt1), 'sin branch si no se pide');
const dt2 = deriveTitleText('Arreglar el login de autenticación', true);
ok(/^claude\/[a-z0-9-]+$/.test(dt2.branch) && !/[áéíóúñ]/.test(dt2.branch), 'branch: slug ASCII: ' + dt2.branch);
ok(JSON.stringify(JSON.parse(JSON.stringify(dt1))) === JSON.stringify(dt1), 'título serializable a JSON plano (contrato CC)');

console.log(`\n${pass} pasadas, ${fail} fallos`);
process.exit(fail ? 1 : 0);

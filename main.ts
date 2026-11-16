// free-model-aggregator-02: one self-contained server (Node's standard library only) that reads the
// trial's brief, ranks its free models by published rating, and answers each of the trial's six prompts
// with one free model dialled through the grader's gateway — JSON or SSE, on both client wires —
// registering its port and polling the env until done. `node main.ts --list` prints the catalog.
// Every `model` field on an answer or a chunk is the id this server dialled, and the dialled id went
// to the gateway in the request itself, so the claim matches the call. Candidate order, cooldowns
// counted in arrival order and fixed timestamps are pure functions of the brief and the answers, so a
// replay makes the same calls and the same bytes.
import { readFileSync } from 'node:fs'; import { Buffer } from 'node:buffer'; import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'; const MODELS_SCHEMA = 'free-model-aggregator-02/models/v1'; const PROMPTS_SCHEMA = 'free-model-aggregator-02/prompts/v1'; const SCHEMA_PREFIX = 'free-model-aggregator-02/'; const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1'; const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY'; type Json = Record<string, unknown>; const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
interface ModelRow { id: string; provider: string; display_name: string; rating_milli: number; context_length: number | null; tools: boolean | null; vision: boolean | null; json: boolean | null; free: boolean }
interface Requirement { tools?: boolean; vision?: boolean; json?: boolean; min_context?: number }
interface PromptRow { id: string; api: 'openai' | 'anthropic'; stream: boolean; weight: 1 | 2; requires: Requirement }
interface Brief { models: ModelRow[]; prompts: PromptRow[]; error: string | null }
interface CatalogModel { id: string; free: boolean; context_length: number | null }
interface CatalogReport { providers: Array<{ id: string; base_url: string; key_env: string; wire: 'openai'; models: CatalogModel[] }> }
interface ServedModel { id: string; provider: string; display_name: string }
/** Every JSON object in `text` that carries a string `schema`, in the order they appear. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch { /* Not JSON on its own: look on. */ }
  }
  return out;
}
/** The index of the `}` closing the object that opens at `start`, or -1; string contents are skipped. */
function objectEnd(text: string, start: number): number {
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (ch === '\\') i += 1; else if (ch === '"') inString = false; }
    else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}
const stringOf = (v: unknown): string => (typeof v === 'string' ? v : ''); const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null); const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null); const numberOrZero = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
/** The first document under this contest's prefix that carries one of `keys` as an array. */
function arrayDocument(docs: readonly Json[], keys: readonly string[]): {
  doc: Json;
  key: string } | null { for (const doc of docs) { if (!stringOf(doc.schema).includes(SCHEMA_PREFIX)) continue; for (const key of keys) if (Array.isArray(doc[key])) return { doc, key }; } return null;
}
/** One model row: the row's `id`, or its `model` under a provider that names `openrouter`, as the gateway spells it. */
function modelOf(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const raw = stringOf(v.id) !== '' ? stringOf(v.id) : stringOf(v.model);
  if (raw === '') return null;
  const named = stringOf(v.provider) !== '' ? stringOf(v.provider) : stringOf(v.wire);
  const id = named === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/') ? `openrouter/${raw}` : raw;
  return { id, provider: named === '' ? 'openrouter' : named, display_name: stringOf(v.display_name) !== '' ? stringOf(v.display_name) : raw, rating_milli: numberOrNull(v.rating_milli) ?? 0, context_length: numberOrNull(v.context_length), tools: boolOrNull(v.tools), vision: boolOrNull(v.vision), json: boolOrNull(v.json), free: v.free !== false };
}
function promptOf(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  const id = stringOf(v.id);
  if (id === '') return null;
  const r = isRecord(v.requires) ? v.requires : {};
  return { id, api: v.api === 'anthropic' ? 'anthropic' : 'openai', stream: v.stream === true, weight: v.weight === 2 ? 2 : 1, requires: { ...(r.tools === true ? { tools: true } : {}), ...(r.vision === true ? { vision: true } : {}), ...(r.json === true ? { json: true } : {}), ...(typeof r.min_context === 'number' && Number.isFinite(r.min_context) ? { min_context: r.min_context } : {}) } };
}
/** The brief at `path`: its two documents, found by the arrays they carry under the schema prefix. */
function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (err) { return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` }; }
  const docs = documentsIn(text); const modelsDoc = arrayDocument(docs, ['models', 'ratings']);
  if (modelsDoc === null) return { models: [], prompts: [], error: `the brief at ${path} holds no ${MODELS_SCHEMA} document` };
  const models = (modelsDoc.doc[modelsDoc.key] as unknown[]).flatMap((v) => { const m = modelOf(v); return m === null ? [] : [m]; });
  const promptsDoc = arrayDocument(docs, ['prompts', 'manifest']);
  if (promptsDoc === null) return { models, prompts: [], error: `the brief at ${path} holds no ${PROMPTS_SCHEMA} document` };
  const prompts = (promptsDoc.doc[promptsDoc.key] as unknown[]).flatMap((v) => { const p = promptOf(v); return p === null ? [] : [p]; });
  return { models, prompts, error: null };
}
const freeModels = (brief: Brief): ModelRow[] => brief.models.filter((m) => m.free);
const capabilitiesOf = (model: ModelRow) => ({ context_length: model.context_length, tools: model.tools, vision: model.vision, json: model.json });
/** Whether a model's capabilities meet one prompt's requirements. An unknown capability never meets one. */
function meetsRequirements(requires: Requirement, caps: ReturnType<typeof capabilitiesOf>): boolean {
  if (requires.tools === true && caps.tools !== true) return false;
  if (requires.vision === true && caps.vision !== true) return false;
  if (requires.json === true && caps.json !== true) return false;
  if (requires.min_context !== undefined && (caps.context_length === null || caps.context_length < requires.min_context)) return false;
  return true;
}
/** The catalog: one openrouter provider, the brief's free models once each, its public base URL. */
function buildCatalog(brief: Brief): CatalogReport {
  const seen = new Set<string>(); const models: CatalogModel[] = [];
  for (const model of brief.models) { if (!model.free || seen.has(model.id)) continue; seen.add(model.id); models.push({ id: model.id, free: true, context_length: model.context_length }); } if (models.length === 0) return { providers: [] };
  return { providers: [{ id: 'openrouter', base_url: OPENROUTER_PUBLIC_BASE, key_env: OPENROUTER_KEY_ENV, wire: 'openai', models }] };
}
const FIXED_OPENAI_CREATED = 1767225600; const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';
const openAIModelList = (models: readonly ServedModel[]): Json => ({ object: 'list', data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_OPENAI_CREATED, owned_by: m.provider })) });
const anthropicModelList = (models: readonly ServedModel[]): Json => ({ data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: FIXED_ANTHROPIC_CREATED_AT })), has_more: false });
const anthropicError = (type: string, message: string): Json => ({ type: 'error', error: { type, message } });
const openAIError = (message: string, type: string, code: string | null): Json => ({ error: { message, type, code } });
/** The text of a string or of a block array's text blocks; '' when there is none. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}
/** One Anthropic content block as a Chat Completions content part: text or an inline image; null for the rest. */
function partOf(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && isRecord(block.source)) { const source = block.source; if (source.type === 'base64' && typeof source.data === 'string') { const media = typeof source.media_type === 'string' ? source.media_type : 'image/png'; return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } }; } if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } }; } return null;
}
/** A tool_result block's content as text: its text blocks, or its JSON when it holds something else. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) { const text = textOf(content); return text !== '' ? text : JSON.stringify(content); } return content === undefined ? '' : JSON.stringify(content);
}
/** A tool call's arguments as an object: the gateway's JSON string, or {} when it is not one. */
function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') { try { const parsed: unknown = JSON.parse(value); if (isRecord(parsed)) return parsed; } catch { /* Not JSON: an empty input. */ } } return {};
}
/** Chat Completions' finish_reason as Anthropic's stop_reason. */
function stopReasonOf(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}
/** An Anthropic Messages request as a Chat Completions request that names `model`. */
function anthropicToChat(body: Json, model: string): Json {
  const messages: Json[] = []; const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') { messages.push({ role: assistant ? 'assistant' : 'user', content }); continue; } if (!Array.isArray(content)) continue;
    if (assistant) { const toolCalls: Json[] = []; for (const block of content) { if (!isRecord(block) || block.type !== 'tool_use') continue; toolCalls.push({ id: typeof block.id === 'string' ? block.id : '', type: 'function', function: { name: typeof block.name === 'string' ? block.name : '', arguments: JSON.stringify(isRecord(block.input) ? block.input : {}) } }); } const text = textOf(content); messages.push({ role: 'assistant', content: text !== '' ? text : null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }); continue; } const parts: Json[] = [];
    for (const block of content) { if (!isRecord(block)) continue; if (block.type === 'tool_result') { messages.push({ role: 'tool', tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '', content: toolResultText(block.content) }); continue; } const part = partOf(block); if (part !== null) parts.push(part); } if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [{ type: 'function', function: { name: raw.name, description: typeof raw.description === 'string' ? raw.description : '', parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} } } }];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  if (body.stream === true) { out.stream = true; out.stream_options = { include_usage: true }; }
  return out;
}
/** A Chat Completions answer as an Anthropic Messages object. `model` is the id the entry dialled. */
function chatToAnthropic(body: Json, model: string): Json {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  if (text !== '') content.push({ type: 'text', text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) { if (!isRecord(call) || !isRecord(call.function)) continue; content.push({ type: 'tool_use', id: typeof call.id === 'string' ? call.id : 'toolu_unknown', name: typeof call.function.name === 'string' ? call.function.name : '', input: argumentsOf(call.function.arguments) }); } if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = isRecord(body.usage) ? body.usage : {};
  return { id: `msg_${typeof body.id === 'string' ? body.id : 'aggregate'}`, type: 'message', role: 'assistant', model, content, stop_reason: stopReasonOf(choice.finish_reason), stop_sequence: null, usage: { input_tokens: numberOrZero(usage.prompt_tokens), output_tokens: numberOrZero(usage.completion_tokens) } };
}
const openAIJsonWithModel = (body: Json, model: string): Json => ({ ...body, model });
const sseEvent = (event: string | null, data: unknown): string => `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
/** One SSE frame with every data payload's `model` set to `model`, its blank line and other lines kept. */
function frameWithModel(frame: string, model: string): string {
  const lines = frame.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return line;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;
    try { const chunk: unknown = JSON.parse(payload); if (isRecord(chunk)) return `data: ${JSON.stringify({ ...chunk, model })}`; } catch { /* Not JSON: relay the line as it came. */ }
    return line;
  });
  return `${lines.join('\n')}\n\n`;
}
/** A Chat Completions SSE stream frame by frame, every data payload's `model` the id the entry dialled. */
async function* openAIStreamWithModel(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader(); const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) { const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2); yield frameWithModel(frame, model); at = buffer.indexOf('\n\n'); }
    }
    buffer += decoder.decode(); if (buffer.trim() !== '') yield frameWithModel(buffer, model);
  } finally { reader.releaseLock(); }
}
/** A Chat Completions SSE stream as the Anthropic event sequence, `model` named throughout. */
async function* chatEventsAsAnthropic(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = upstream.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let started = false, finished = false, pendingStop: string | null = null, textIndex = -1, nextIndex = 0;
  const toolIndexes = new Map<number, number>();
  let inputTokens = 0, outputTokens = 0;
  const startEvents = (): string[] => {
    if (started) return [];
    started = true; return [sseEvent('message_start', { type: 'message_start', message: { id: 'msg_stream', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } })];
  };
  const closeEvents = (): string[] => {
    const out: string[] = [];
    if (textIndex !== -1) { out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex })); textIndex = -1; }
    for (const index of [...toolIndexes.values()].sort((a, b) => a - b)) out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    toolIndexes.clear(); return out;
  };
  const finishEvents = (stopReason: string): string[] => {
    if (finished) return [];
    finished = true; return [...closeEvents(), sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }), sseEvent('message_stop', { type: 'message_stop' })];
  };
  /** One SSE frame's lines as Anthropic events, mutating the stream's state. */
  const eventsOfFrame = (frame: string): string[] => {
    const out: string[] = [];
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') { out.push(...startEvents(), ...finishEvents(pendingStop ?? 'end_turn')); continue; }
      let chunk: unknown;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (!isRecord(chunk)) continue;
      if (isRecord(chunk.usage)) { inputTokens = numberOrZero(chunk.usage.prompt_tokens); outputTokens = numberOrZero(chunk.usage.completion_tokens); }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : []; const choice = isRecord(choices[0]) ? choices[0] : null;
      if (choice === null) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      out.push(...startEvents());
      if (typeof delta.content === 'string' && delta.content !== '') { if (textIndex === -1) { textIndex = nextIndex; nextIndex += 1; out.push(sseEvent('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } })); } out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } })); }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const upstreamIndex = typeof call.index === 'number' ? call.index : toolIndexes.size;
        let index = toolIndexes.get(upstreamIndex);
        if (index === undefined) { if (textIndex !== -1) { out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex })); textIndex = -1; } index = nextIndex; nextIndex += 1; toolIndexes.set(upstreamIndex, index); const fn = isRecord(call.function) ? call.function : {}; out.push(sseEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${index}`, name: typeof fn.name === 'string' ? fn.name : '', input: {} } })); } const fn = isRecord(call.function) ? call.function : {};
        if (typeof fn.arguments === 'string' && fn.arguments !== '') out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
      }
      // Hold the stop reason until the stream's last chunk (the usage one) and [DONE] have arrived.
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) pendingStop = stopReasonOf(choice.finish_reason);
    }
    return out;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) { const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2); for (const event of eventsOfFrame(frame)) yield event; at = buffer.indexOf('\n\n'); }
    }
    buffer += decoder.decode(); if (buffer.trim() !== '') for (const event of eventsOfFrame(buffer)) yield event;
  } finally { reader.releaseLock(); }
  if (!finished) { for (const event of startEvents()) yield event; for (const event of finishEvents(pendingStop ?? 'end_turn')) yield event; }
}
const PROTOCOL_VERSION = 1; const POLL_INTERVAL_MS = 100; const MAX_BODY_BYTES = 8 * 1024 * 1024; const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, ''); const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? ''; const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, ''); const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? ''; const brief = readBrief(PROMPT_FILE); const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
function log(message: string): void { process.stderr.write(`aggregator: ${message}\n`); }
const chatCompletionsUrl = (): string => (GATEWAY_URL === '' ? '' : GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`);
const servedModels = (): ServedModel[] => freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
/** Every free model that meets `requires`, best rating first, ties on the id: the head is the model to dial, the tail the failover order, a pure function of the brief. */
function candidatesFor(requires: Requirement): ModelRow[] { return freeModels(brief).filter((model) => meetsRequirements(requires, capabilitiesOf(model))).sort((a, b) => b.rating_milli - a.rating_milli || a.id.localeCompare(b.id)); }
/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) { if (!isRecord(message) || !Array.isArray(message.content)) continue; for (const block of message.content) { if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true; } } const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}
/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); size += buffer.length; if (size > MAX_BODY_BYTES) return null; chunks.push(buffer); }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch { return null; }
}
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
const sendError = (res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void => { if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message)); else sendJson(res, status, openAIError(message, type, null)); };
/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void { const list = servedModels(); if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list)); else sendJson(res, 200, openAIModelList(list)); }
/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}
/** Deterministic per-model cooldown, counted in client requests, never in time: a replay makes the same calls as the live pass. A model refused with 429/402 or a 5xx sits out the next few prompts. */
const COOLDOWN_REQUESTS = 3; const cooldownUntil = new Map<string, number>();
const markRefused = (model: string): void => { cooldownUntil.set(model, manifestIndex + COOLDOWN_REQUESTS); };
const isCooling = (model: string): boolean => (cooldownUntil.get(model) ?? 0) > manifestIndex;
/** The error code a gateway refusal names, for the failure trail's rows. */
async function codeOfRefusal(upstream: Response): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await upstream.text());
    if (isRecord(parsed) && isRecord(parsed.error)) { const code = parsed.error.code ?? parsed.error.type; if (typeof code === 'string' && code !== '') return code; }
    if (isRecord(parsed) && typeof parsed.code === 'string' && parsed.code !== '') return parsed.code;
  } catch { /* No JSON body: fall through to the status text. */ }
  return `http_${upstream.status}`;
}
/** Serve one completion prompt in the wire the client used: dial the best free model that meets the prompt's requirements, and on a refused call fail over down the rating order, cooling each refused model; the refusals retried and served ride back in `x-makefun-upstream-failures`. */
async function serve(req: IncomingMessage, res: ServerResponse, wire: 'openai' | 'anthropic'): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, wire, 400, 'invalid_request_error', 'the request body is not one JSON object');
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1; const requires = entry !== undefined ? entry.requires : requirementsFromBody(body); const candidates = candidatesFor(requires); if (candidates.length === 0) return sendError(res, wire, 503, wire === 'anthropic' ? 'overloaded_error' : 'no_free_model', 'no free model in the brief meets this request'); const failures: Array<{ status: number; code: string; model: string | null }> = [];
  const trailHeader = (): Record<string, string> => {
    if (failures.length === 0) return {};
    const value = JSON.stringify(failures.slice(0, 8).map((f) => ({ status: f.status, code: f.code, model: f.model })));
    return value.length <= 4096 ? { 'x-makefun-upstream-failures': value } : {};
  };
  for (let round = 0; round < 2; round += 1) {
    for (const model of candidates) {
      // First pass skips cooling models; the second spends a call on one only when nothing healthier met the prompt.
      if (round === 0 && isCooling(model.id)) continue;
      let upstream: Response;
      try {
        upstream = await dial(model.id, wire === 'anthropic' ? anthropicToChat(body, model.id) : { ...body, model: model.id });
      } catch { failures.push({ status: 0, code: 'network_error', model: model.id }); continue; }
      if (!upstream.ok || upstream.body === null) {
        const code = await codeOfRefusal(upstream);
        failures.push({ status: upstream.status, code, model: model.id });
        if (upstream.status === 429 || upstream.status === 402 || upstream.status >= 500) markRefused(model.id);
        continue;
      }
      const headers = trailHeader();
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
        try {
          if (wire === 'anthropic') { for await (const event of chatEventsAsAnthropic(upstream.body, model.id)) res.write(event); }
          else { for await (const frame of openAIStreamWithModel(upstream.body, model.id)) res.write(frame); }
        } finally { res.end(); }
        return;
      }
      const answer: unknown = await upstream.json(); const shaped = wire === 'anthropic' ? chatToAnthropic(isRecord(answer) ? answer : {}, model.id) : openAIJsonWithModel(isRecord(answer) ? answer : {}, model.id);
      sendJson(res, 200, shaped, headers); return;
    }
  }
  // Every candidate refused, both passes: answer the failure the client's wire spells, so the env records the refusal.
  const last = failures[failures.length - 1];
  sendError(res, wire, 502, wire === 'anthropic' ? 'api_error' : 'upstream_error', last !== undefined ? `every free model refused this request; the last answered HTTP ${last.status} ${last.code}` : 'no free model could be dialled');
}
const chat = (req: IncomingMessage, res: ServerResponse): Promise<void> => serve(req, res, 'openai'); const messages = (req: IncomingMessage, res: ServerResponse): Promise<void> => serve(req, res, 'anthropic');
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') { models(req, res); return; } if (req.method === 'POST' && url.pathname === '/v1/chat/completions') { await chat(req, res); return; } if (req.method === 'POST' && url.pathname === '/v1/messages') { await messages(req, res); return; } sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}
const listen = (server: Server): Promise<void> => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', () => resolve()); });
/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }), signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}
/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) { clearInterval(timer); server.close(); process.exit(0); }
      } catch { /* The env is not reachable yet: try again on the next tick. */ } finally { inFlight = false; }
    })();
  }, POLL_INTERVAL_MS);
}
async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print it whole and stop before any server starts.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve())); process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set'); if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err)); if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server); const address = server.address(); if (address === null || typeof address === 'string') throw new Error('the server has no port'); const port = address.port; if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial'); log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`); await register(port, catalog); process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0)); poll(server);
}
try {
  await start();
} catch (err) { log((err as Error).stack ?? String(err)); process.exit(1); }

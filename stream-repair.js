/**
 * Repair streamed tool-call identity before pi-ai parses it.
 *
 * Why this exists. pi-ai identifies a streamed tool call by *position*, not by
 * id, in both of its response parsers:
 *
 *   - `openai-responses-shared.js` keeps one slot per `output_index`
 *     (`outputSlots`; `getSlot` returns a slot only when its type matches);
 *   - `openai-completions.js` keys blocks by `tool_calls[].index`.
 *
 * A gateway that reuses one position for two parallel calls therefore merges
 * them: both argument strings land in one block and the finished call is parsed
 * as a single JSON value. That is the reported failure —
 *
 *   Tool call "grep": Unexpected non-whitespace character after JSON at position
 *   186 (line 1 column 187)
 *   Received arguments: {"pattern": …}{"pattern": …}
 *
 * where 186 is exactly the length of the *first* call's arguments. The adapter
 * (`dsh-llm-pi-ai/src/stream.ts:210-231`) turns that into `MALFORMED_RESPONSE`,
 * which the default retry policy does not retry, so the turn dies on the first
 * attempt.
 *
 * Both protocols do carry the id — `item_id` / `item.id` for the Responses API,
 * `tool_calls[].id` for chat completions; the shipped parsers just never use it
 * to choose a slot. This module reads the id and rewrites the positional field,
 * which is all the parsers need: every call gets its own slot again.
 *
 * What it cannot do: recover when events carry no id at all (nothing to key on),
 * split one argument string that genuinely holds two JSON objects, or relocate
 * the text of a call the server never announced. A retry policy that retries
 * `MALFORMED_RESPONSE` is the complement, not a substitute.
 */

/** Strip the query string, keeping origin and path (exact-match key). */
function endpointKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

const noop = () => {};

/**
 * Canonical `output_index` per tool-call identity, for one Responses stream.
 *
 * An event that names an item owns that item's slot; a new *announced* item
 * arriving on a reused wire index is moved to a free one. Two things are
 * deliberately left alone:
 *
 *   - events with no id — there is nothing to key on;
 *   - deltas for an item the server never announced. Relocating those would put
 *     the text on a slot the parser has no block for, which silently drops a
 *     tool call the model asked for. Leaving them merged keeps the failure
 *     visible, so the retry policy can re-ask; a wrong-but-quiet turn is worse
 *     than a failed one.
 *
 * @param onRepair - called once per rewritten event, with its `type`.
 * @returns a function that mutates one decoded SSE chunk and reports change.
 */
export function createResponsesNormalizer(onRepair = noop) {
  /** item id -> canonical output_index */
  const byItem = new Map();
  /** ids the server announced with `output_item.added` */
  const announced = new Set();
  /** every canonical index already handed out */
  const taken = new Set();
  let next = 0;

  const allocate = (wire) => {
    if (Number.isInteger(wire) && wire >= 0 && !taken.has(wire)) {
      taken.add(wire);
      return wire;
    }
    while (taken.has(next)) next += 1;
    const assigned = next;
    taken.add(assigned);
    return assigned;
  };

  return (chunk) => {
    if (chunk === null || typeof chunk !== 'object') return false;
    const item = chunk.item !== null && typeof chunk.item === 'object' ? chunk.item : undefined;
    const itemId = typeof chunk.item_id === 'string' && chunk.item_id !== ''
      ? chunk.item_id
      : typeof item?.id === 'string' && item.id !== '' ? item.id : undefined;
    if (itemId === undefined) return false;

    const isAnnouncement = chunk.type === 'response.output_item.added';
    const known = byItem.get(itemId);
    if (known === undefined && !isAnnouncement && !announced.has(itemId)) {
      // Nothing owns this text yet and the server never introduced the call.
      return false;
    }

    const wire = Number.isInteger(chunk.output_index) ? chunk.output_index : undefined;
    let canonical = known;
    if (canonical === undefined) {
      canonical = allocate(wire);
      byItem.set(itemId, canonical);
    }
    if (isAnnouncement) announced.add(itemId);
    if (chunk.output_index !== canonical) {
      chunk.output_index = canonical;
      onRepair(typeof chunk.type === 'string' ? chunk.type : 'unknown');
      return true;
    }
    return false;
  };
}

/**
 * Canonical `tool_calls[].index` per call id, for one chat-completions stream.
 *
 * Mirrors the Responses repair: a gateway may reuse a wire index for a new id,
 * and pi-ai then merges the two calls. Fragments without an id follow the call
 * most recently seen on their index; a header can also name the id after an
 * anonymous first fragment.
 *
 * @param onRepair - called once per rewritten fragment.
 */
export function createCompletionsNormalizer(onRepair = noop) {
  const byChoice = new Map();

  return (chunk) => {
    if (!Array.isArray(chunk?.choices)) return false;
    let changed = false;
    for (const choice of chunk.choices) {
      const calls = choice?.delta?.tool_calls;
      if (!Array.isArray(calls)) continue;
      const choiceIndex = choice.index ?? 0;
      let state = byChoice.get(choiceIndex);
      if (state === undefined) {
        state = { byId: new Map(), active: new Map(), taken: new Set(), next: 0 };
        byChoice.set(choiceIndex, state);
      }
      for (const call of calls) {
        if (call === null || typeof call !== 'object') continue;
        const wire = call.index;
        if (!Number.isInteger(wire) || wire < 0) continue;
        const id = typeof call.id === 'string' && call.id !== '' ? call.id : undefined;

        const allocate = () => {
          if (!state.taken.has(wire)) {
            state.taken.add(wire);
            return wire;
          }
          while (state.taken.has(state.next)) state.next += 1;
          const assigned = state.next;
          state.taken.add(assigned);
          return assigned;
        };

        let canonical = id === undefined ? state.active.get(wire) : state.byId.get(id);
        if (canonical === undefined) {
          // A header can name the id after an anonymous first fragment: keep the
          // slot that fragment already owns instead of starting a second call.
          const active = state.active.get(wire);
          const activeHasId = active !== undefined && [...state.byId.values()].includes(active);
          canonical = active !== undefined && !activeHasId ? active : allocate();
        }
        state.taken.add(canonical);
        if (id !== undefined) state.byId.set(id, canonical);
        state.active.set(wire, canonical);
        if (call.index !== canonical) {
          call.index = canonical;
          changed = true;
          onRepair();
        }
      }
    }
    return changed;
  };
}

/**
 * Re-frame one SSE frame, returning it byte-identical when nothing changed.
 *
 * Frames that are not JSON, or that the normalizer leaves alone, keep their
 * original bytes: comment lines, `event:` names and `[DONE]` all survive.
 */
function frameRepair(normalizer) {
  return (text) => {
    const lines = text.split(/\r\n|\r|\n/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '' || data.trim() === '[DONE]') return text;
    let chunk;
    try { chunk = JSON.parse(data); }
    catch { return text; }
    if (normalizer(chunk) !== true) return text;
    let emitted = false;
    return lines.flatMap((line) => {
      if (!line.startsWith('data:')) return [line];
      if (emitted) return [];
      emitted = true;
      return [`data: ${JSON.stringify(chunk)}`];
    }).join('\n');
  };
}

/** Decode SSE across arbitrary UTF-8 and network chunk boundaries. */
function repairedEventStream(body, repairFrame) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const drain = (controller, final = false) => {
    let match;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(pending)) !== null) {
      const text = pending.slice(0, match.index);
      const separator = match[0];
      pending = pending.slice(match.index + separator.length);
      controller.enqueue(encoder.encode(repairFrame(text) + separator));
    }
    if (final && pending !== '') {
      controller.enqueue(encoder.encode(repairFrame(pending)));
      pending = '';
    }
  };
  return body.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      drain(controller);
    },
    flush(controller) {
      pending += decoder.decode();
      drain(controller, true);
    },
  }));
}

/** The two wire protocols whose parsers key tool calls by position. */
const RESPONSES = 'responses';
const COMPLETIONS = 'completions';

/**
 * Install a reversible fetch wrapper for exactly the configured endpoints.
 *
 * Request bodies, credentials and every other URL pass through untouched. Only a
 * `text/event-stream` response on a configured endpoint is re-framed, and only
 * frames whose positional field had to change are re-encoded.
 *
 * @param target - the object owning `fetch` (normally `globalThis`).
 * @param endpoints - `{ url, dialect }`, dialect `responses` or `completions`.
 * @param stats - mutable counters surfaced by the panel; default counters are
 *   created per install so two profiles never share them.
 * @returns a disposer restoring the previous `fetch`.
 */
export function installStreamRepair(target, endpoints, stats = { responses: 0, repairedEvents: 0 }) {
  const previous = target.fetch;
  const byKey = new Map();
  for (const endpoint of Array.isArray(endpoints) ? endpoints : []) {
    const key = endpointKey(endpoint?.url);
    if (key === undefined) continue;
    byKey.set(key, endpoint.dialect === COMPLETIONS ? COMPLETIONS : RESPONSES);
  }
  if (byKey.size === 0) return noop;

  const wrapped = async function (input, init) {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const response = await previous.call(this, input, init);
    const dialect = typeof raw === 'string' ? byKey.get(endpointKey(raw)) : undefined;
    if (dialect === undefined || !response.ok || !response.body) return response;
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return response;

    const normalizer = dialect === COMPLETIONS
      ? createCompletionsNormalizer(() => { stats.repairedEvents += 1; })
      : createResponsesNormalizer(() => { stats.repairedEvents += 1; });
    stats.responses += 1;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    // fetch already decoded the body, so the header would decode it twice.
    headers.delete('content-encoding');
    return new Response(repairedEventStream(response.body, frameRepair(normalizer)), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  target.fetch = wrapped;
  return () => {
    if (target.fetch === wrapped) target.fetch = previous;
  };
}

/** The Codex backend URL the installed catalog resolves for `openai-codex`. */
export const DEFAULT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/**
 * Endpoints this plugin repairs, given its configuration.
 *
 * The Codex backend is always included because that is the route the plugin
 * enables. Operators on a relay (a different `baseUrl` in the route profile) can
 * name theirs explicitly.
 *
 * @param extra - `endpoints` from config: strings, or `{ url, dialect }`.
 */
export function resolveRepairEndpoints(extra = []) {
  const endpoints = [{ url: DEFAULT_CODEX_RESPONSES_URL, dialect: RESPONSES }];
  for (const entry of Array.isArray(extra) ? extra : []) {
    if (typeof entry === 'string' && entry !== '') endpoints.push({ url: entry, dialect: RESPONSES });
    else if (entry !== null && typeof entry === 'object' && typeof entry.url === 'string' && entry.url !== '') {
      endpoints.push({ url: entry.url, dialect: entry.dialect === COMPLETIONS ? COMPLETIONS : RESPONSES });
    }
  }
  const seen = new Set();
  return endpoints.filter((endpoint) => {
    const key = endpointKey(endpoint.url);
    if (key === undefined || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

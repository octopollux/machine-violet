import { createHash } from "node:crypto";
import type { LLMProvider, ChatParams, ChatResult, NormalizedMessage, NormalizedToolCall, DispatchToolFn } from "../providers/types.js";
import type { FileIO } from "./scene-manager.js";
import { norm } from "../utils/paths.js";

interface NativeReceipt { call: NormalizedToolCall; result?: Awaited<ReturnType<DispatchToolFn>> }
interface DurableRound { request: ChatParams; result?: ChatResult; acceptedNative: NativeReceipt[] }

/** Exact accepted provider intent replay, including providers dispatching tools in-band. */
export function durableReplayProvider(base: LLMProvider, io: FileIO, root: string, scope: string, assertCurrent: () => void): LLMProvider {
  let round = 0;
  const provider: LLMProvider = Object.create(base) as LLMProvider;
  const invoke = async (params: ChatParams, onDelta?: (delta: string) => void): Promise<ChatResult> => {
    assertCurrent();
    const directory = norm(`${root}/state/provider-journals/${createHash("sha256").update(scope).digest("hex")}`);
    const path = norm(`${directory}/${round}.json`);
    const prior = await io.exists(path) ? JSON.parse(await io.readFile(path)) as DurableRound : undefined;
    const state: DurableRound = prior ?? { request: JSON.parse(JSON.stringify(params)) as ChatParams, acceptedNative: [] };
    let writes: Promise<void> = Promise.resolve();
    const persist = () => {
      const write = writes.then(async () => { assertCurrent(); await io.mkdir(directory); assertCurrent(); await (io.writeFileAtomic?.(path, JSON.stringify(state)) ?? io.writeFile(path, JSON.stringify(state))); });
      writes = write.catch(() => undefined); return write;
    };
    if (state.result) {
      round++;
      onDelta?.(state.result.text);
      return { ...structuredClone(state.result), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 } };
    }
    if (!prior) await persist();
    let request = { ...state.request, dispatchTool: params.dispatchTool } as ChatParams;
    if (params.dispatchTool) {
      const dispatch = params.dispatchTool;
      const continuation: NormalizedMessage[] = [];
      for (const receipt of state.acceptedNative) {
        // Known results have durable effect receipts. Only the uncertain gap
        // re-enters the owning dispatcher, which enforces atomic operation IDs.
        receipt.result ??= await dispatch(receipt.call);
        await persist();
        continuation.push({ role: "assistant", content: [{ type: "tool_use", id: receipt.call.id, name: receipt.call.name, input: receipt.call.input }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: receipt.call.id, content: receipt.result.content, is_error: receipt.result.isError }] });
      }
      request = { ...request, messages: [...request.messages, ...continuation], dispatchTool: async (call: NormalizedToolCall) => {
        assertCurrent();
        const existing = state.acceptedNative.find(item => item.call.id === call.id);
        if (existing) {
          if (existing.call.name !== call.name || JSON.stringify(existing.call.input) !== JSON.stringify(call.input)) return { content: "An accepted native tool ID cannot be reused for changed intent.", isError: true };
          if (existing.result) return existing.result;
        }
        const receipt = existing ?? { call: structuredClone(call) };
        if (!existing) state.acceptedNative.push(receipt);
        await persist(); receipt.result = await dispatch(call); await persist(); return receipt.result;
      } } as ChatParams;
    }
    const result = onDelta && base.stream ? await base.stream(request, onDelta) : await base.chat(request);
    assertCurrent(); state.result = structuredClone(result); await persist(); assertCurrent(); round++;
    return result;
  };
  provider.chat = params => invoke(params);
  provider.stream = (params, onDelta) => invoke(params, onDelta);
  return provider;
}

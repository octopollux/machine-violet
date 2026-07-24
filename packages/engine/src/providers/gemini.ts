/**
 * Google Gemini provider adapter.
 *
 * Uses the current @google/genai Interactions API rather than the legacy
 * @google/generative-ai generateContent surface. Interactions is Google's
 * recommended API for the latest models and exposes one coherent step model
 * for streaming text, thought summaries, and function calls.
 */
import { GoogleGenAI, type Interactions } from "@google/genai";
import type {
  ChatParams,
  ChatResult,
  ContentPart,
  GenerateImageRequest,
  GenerateImageResult,
  HealthCheckResult,
  ImageAspect,
  ImageEffort,
  LLMProvider,
  NormalizedMessage,
  NormalizedToolCall,
  NormalizedUsage,
  StopReason,
} from "./types.js";
import { supportsImageGeneration } from "../config/model-registry.js";

const HEALTH_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

type GeminiInteraction = Pick<
  Interactions.Interaction,
  "id" | "status" | "steps" | "usage" | "output_text" | "output_image"
>;

type GeminiCreateParams = Interactions.CreateModelInteractionParamsNonStreaming;

const EFFORT_TO_IMAGE_SIZE: Record<ImageEffort, "512" | "1K" | "2K" | "4K"> = {
  draft: "512",
  standard: "1K",
  quality: "2K",
  showcase: "4K",
};

const ASPECT_TO_RATIO: Record<ImageAspect, "2:3" | "3:2" | "1:1"> = {
  portrait: "2:3",
  landscape: "3:2",
  square: "1:1",
};

export function createGeminiProvider(apiKey?: string): LLMProvider {
  const client = new GoogleGenAI(apiKey ? { apiKey } : {});

  return {
    providerId: "gemini",
    getCapabilities: (model) => ({
      imageGeneration: supportsImageGeneration(model),
    }),
    chat: (params) => geminiChat(client, params, false),
    stream: (params, onDelta) => geminiChat(client, params, true, onDelta),
    healthCheck: (model) => geminiHealthCheck(client, model),
    generateImage: (req) => geminiGenerateImage(client, req),
  };
}

async function geminiChat(
  client: GoogleGenAI,
  params: ChatParams,
  streaming: boolean,
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  const request = toGeminiParams(params);
  if (!streaming) {
    const interaction = await client.interactions.create(request) as Interactions.Interaction;
    return fromGeminiInteraction(interaction);
  }

  const stream = await client.interactions.create({ ...request, stream: true });
  const steps: Interactions.Step[] = [];
  const argumentDeltas = new Map<number, string>();
  let id = "";
  let status = "in_progress";
  let usage: Interactions.Usage | undefined;

  for await (const event of stream) {
    if (event.event_type === "interaction.created" || event.event_type === "interaction.completed") {
      id = event.interaction.id;
      status = event.interaction.status;
      usage = event.interaction.usage ?? usage;
      if (event.interaction.steps?.length) {
        steps.splice(0, steps.length, ...event.interaction.steps);
      }
      continue;
    }

    if (event.event_type === "interaction.status_update") {
      status = event.status;
      continue;
    }

    if (event.event_type === "step.start") {
      steps[event.index] = structuredClone(event.step);
      continue;
    }

    if (event.event_type === "step.delta") {
      usage = event.metadata?.total_usage ?? usage;
      applyStreamDelta(steps, argumentDeltas, event);
      if (
        event.delta.type === "text"
        && event.delta.text
        && steps[event.index]?.type === "model_output"
      ) {
        onDelta?.(event.delta.text);
      }
      continue;
    }

    if (event.event_type === "step.stop") {
      usage = event.usage ?? event.step_usage ?? usage;
    }
  }

  for (const [index, raw] of argumentDeltas) {
    const step = steps[index];
    if (step?.type !== "function_call") continue;
    try {
      step.arguments = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Preserve the raw payload rather than dropping a malformed tool call;
      // the tool dispatcher will return a normal is_error result.
      step.arguments = { _raw: raw };
    }
  }

  return fromGeminiInteraction({
    id,
    status,
    steps: steps.filter(Boolean),
    usage,
  });
}

function applyStreamDelta(
  steps: Interactions.Step[],
  argumentDeltas: Map<number, string>,
  event: Interactions.StepDelta,
): void {
  const step = steps[event.index];
  if (!step) return;
  const delta = event.delta as unknown as Record<string, unknown>;

  if (delta.type === "text" && step.type === "model_output") {
    const text = typeof delta.text === "string" ? delta.text : "";
    const content = step.content ?? (step.content = []);
    const last = content[content.length - 1];
    if (last?.type === "text") last.text += text;
    else content.push({ type: "text", text });
    return;
  }

  if ((delta.type === "arguments_delta" || delta.type === "arguments") && step.type === "function_call") {
    const chunk = typeof delta.arguments === "string"
      ? delta.arguments
      : typeof delta.partial_arguments === "string"
        ? delta.partial_arguments
        : "";
    argumentDeltas.set(event.index, (argumentDeltas.get(event.index) ?? "") + chunk);
    return;
  }

  if (delta.type === "thought_summary" && step.type === "thought") {
    const content = delta.content as Interactions.Content | undefined;
    if (content?.type === "text" || content?.type === "image") {
      (step.summary ??= []).push(content);
    }
    return;
  }

  if (delta.type === "thought_signature" && step.type === "thought" && typeof delta.signature === "string") {
    step.signature = delta.signature;
  }
}

/**
 * Convert Machine Violet's normalized history to a stateless Interactions
 * request. Google requires all generated steps (including thought signatures
 * and function calls) to be replayed exactly when `store: false`.
 */
export function toGeminiParams(params: ChatParams): GeminiCreateParams {
  const systemInstruction = typeof params.systemPrompt === "string"
    ? params.systemPrompt
    : params.systemPrompt.map((block) => block.text).join("\n\n");

  const input: Interactions.Step[] = [];
  const toolNamesById = new Map<string, string>();
  for (const message of params.messages) {
    input.push(...toGeminiSteps(message, toolNamesById));
  }

  const generationConfig: Interactions.GenerationConfig = {
    max_output_tokens: params.maxTokens,
  };
  if (params.thinking?.effort) {
    generationConfig.thinking_level =
      params.thinking.effort === "max" ? "high" : params.thinking.effort;
    generationConfig.thinking_summaries = "auto";
  }

  return {
    model: params.model,
    input,
    store: false,
    system_instruction: systemInstruction,
    generation_config: generationConfig,
    ...(params.tools?.length
      ? {
          tools: params.tools.map((tool) => ({
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }
      : {}),
  };
}

function toGeminiSteps(
  message: NormalizedMessage,
  toolNamesById: Map<string, string>,
): Interactions.Step[] {
  if (typeof message.content === "string") {
    return message.role === "user"
      ? [{ type: "user_input", content: [{ type: "text", text: message.content }] }]
      : [{ type: "model_output", content: [{ type: "text", text: message.content }] }];
  }

  const steps: Interactions.Step[] = [];
  let content: Interactions.Content[] = [];

  const flushContent = () => {
    if (content.length === 0) return;
    steps.push(message.role === "user"
      ? { type: "user_input", content }
      : { type: "model_output", content });
    content = [];
  };

  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "image_input") {
      content.push({
        type: "image",
        data: part.base64,
        mime_type: part.mimeType,
        ...(part.lowDetail ? { resolution: "low" as const } : {}),
      });
    } else if (part.type === "tool_use") {
      flushContent();
      toolNamesById.set(part.id, part.name);
      steps.push({
        type: "function_call",
        id: part.id,
        name: part.name,
        arguments: part.input,
        ...(part.geminiSignature ? { signature: part.geminiSignature } : {}),
      } as Interactions.FunctionCallStep);
    } else if (part.type === "tool_result") {
      flushContent();
      steps.push({
        type: "function_result",
        call_id: part.tool_use_id,
        name: toolNamesById.get(part.tool_use_id),
        result: [{ type: "text", text: part.content }],
        is_error: part.is_error,
      });
    } else if (part.type === "gemini_thought") {
      flushContent();
      steps.push({
        type: "thought",
        signature: part.signature,
        summary: part.summary.map((item) =>
          item.type === "text"
            ? { type: "text", text: item.text }
            : {
                type: "image",
                data: item.data,
                mime_type: item.mimeType,
                uri: item.uri,
              }),
      });
    }
    // Foreign provider reasoning/thinking and generated-image audit blocks
    // are deliberately not serialized to Gemini.
  }
  flushContent();
  return steps;
}

export function fromGeminiInteraction(interaction: GeminiInteraction): ChatResult {
  let text = "";
  let thinkingText = "";
  const toolCalls: NormalizedToolCall[] = [];
  const assistantContent: ContentPart[] = [];

  for (const step of interaction.steps ?? []) {
    if (step.type === "thought") {
      const summary: Extract<ContentPart, { type: "gemini_thought" }>["summary"] = [];
      for (const item of step.summary ?? []) {
        if (item.type === "text") {
          thinkingText += item.text;
          summary.push({ type: "text", text: item.text });
        } else if (item.type === "image") {
          summary.push({
            type: "image",
            data: item.data,
            mimeType: item.mime_type,
            uri: item.uri,
          });
        }
      }
      assistantContent.push({
        type: "gemini_thought",
        summary,
        signature: step.signature,
      });
    } else if (step.type === "model_output") {
      for (const item of step.content ?? []) {
        if (item.type !== "text") continue;
        text += item.text;
        assistantContent.push({ type: "text", text: item.text });
      }
    } else if (step.type === "function_call") {
      const input = step.arguments as Record<string, unknown>;
      toolCalls.push({ id: step.id, name: step.name, input });
      assistantContent.push({
        type: "tool_use",
        id: step.id,
        name: step.name,
        input,
        geminiSignature: getGeminiSignature(step),
      });
    }
  }

  return {
    text: text || interaction.output_text || "",
    thinkingText: thinkingText || undefined,
    toolCalls,
    usage: mapGeminiUsage(interaction.usage),
    stopReason: mapGeminiStopReason(interaction.status),
    assistantContent,
  };
}

function getGeminiSignature(step: Interactions.FunctionCallStep): string | undefined {
  const signature = (step as unknown as { signature?: unknown }).signature;
  return typeof signature === "string" ? signature : undefined;
}

export function mapGeminiUsage(usage?: Interactions.Usage): NormalizedUsage {
  return {
    inputTokens: usage?.total_input_tokens ?? 0,
    outputTokens: usage?.total_output_tokens ?? 0,
    cacheReadTokens: usage?.total_cached_tokens ?? 0,
    cacheCreationTokens: 0,
    reasoningTokens: usage?.total_thought_tokens ?? 0,
  };
}

function mapGeminiStopReason(status: string): StopReason {
  if (status === "requires_action") return "tool_use";
  if (status === "incomplete" || status === "budget_exceeded") return "length";
  if (status === "failed" || status === "cancelled") return "refusal";
  return "end";
}

async function geminiHealthCheck(client: GoogleGenAI, model?: string): Promise<HealthCheckResult> {
  try {
    await client.interactions.create({
      model: model ?? HEALTH_MODEL,
      input: "Reply OK.",
      store: false,
      generation_config: {
        max_output_tokens: 8,
        thinking_level: "minimal",
      },
    });
    return { status: "valid", message: "Gemini API key is valid." };
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 401 || status === 403) {
      return { status: "invalid", message: "Gemini API key is invalid or lacks access." };
    }
    if (status === 429) {
      return { status: "rate_limited", message: "Gemini API rate limit reached." };
    }
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Gemini API health check failed.",
    };
  }
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" ? value : undefined;
}

async function geminiGenerateImage(
  client: GoogleGenAI,
  req: GenerateImageRequest,
): Promise<GenerateImageResult> {
  const effort = req.effort ?? "standard";
  const aspect = req.aspect ?? "square";
  const input: Interactions.Content[] = [{ type: "text", text: req.prompt }];

  for (const [index, reference] of (req.referenceImages ?? []).entries()) {
    if (reference.label) {
      input.push({ type: "text", text: `Reference ${index + 1}: ${reference.label}` });
    }
    input.push({
      type: "image",
      data: reference.base64,
      mime_type: reference.mimeType,
    });
  }

  const interaction = await client.interactions.create({
    model: req.imageModel ?? DEFAULT_GEMINI_IMAGE_MODEL,
    input,
    store: false,
    response_format: {
      type: "image",
      aspect_ratio: ASPECT_TO_RATIO[aspect],
      image_size: EFFORT_TO_IMAGE_SIZE[effort],
    },
  });

  const image = interaction.output_image
    ?? interaction.steps
      ?.flatMap((step) => step.type === "model_output" ? (step.content ?? []) : [])
      .find((item) => item.type === "image");

  if (!image?.data) {
    throw new Error("Gemini image generation completed without image bytes.");
  }

  const mimeType: GenerateImageResult["mimeType"] =
    image.mime_type === "image/jpeg"
      ? "image/jpeg"
      : image.mime_type === "image/webp"
        ? "image/webp"
        : "image/png";

  return {
    base64: image.data,
    mimeType,
    effortUsed: effort,
    aspectUsed: aspect,
  };
}

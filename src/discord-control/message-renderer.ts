import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from 'discord.js';
import type { SessionRenderModel } from './render-model.js';

const ASSISTANT_EMBED_COLOR = 0xe0613a;

export type RenderedSessionMessage = Readonly<{
  anchor: SessionRenderModel['anchor'];
  content: string;
  flags?: number;
  components?: readonly unknown[];
  embeds: readonly Readonly<{
    color: number;
    description: string;
  }>[];
}>;

export function renderSessionMessage(
  model: SessionRenderModel,
  options?: { maxChunkLength?: number; waitingPlaceholder?: string }
): RenderedSessionMessage[] {
  const maxChunkLength = Math.max(1, options?.maxChunkLength ?? 1500);
  const assistantText = sanitizeAssistantText(model.text, model.bashDetails);
  const content = assistantText || options?.waitingPlaceholder || 'Waiting for runner output.';

  if (content.length <= maxChunkLength) {
    return [{ anchor: model.anchor, ...buildAssistantMessage(content) }];
  }

  return chunkText(content, maxChunkLength).map((chunk) => ({
    anchor: model.anchor,
    ...buildAssistantMessage(chunk)
  }));
}

function buildAssistantMessage(description: string) {
  return {
    content: '',
    flags: MessageFlags.IsComponentsV2,
    components: [
      new ContainerBuilder()
        .setAccentColor(ASSISTANT_EMBED_COLOR)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(description))
        .toJSON()
    ],
    embeds: []
  };
}

function sanitizeAssistantText(
  text: string,
  bashDetails: readonly {
    output: string;
  }[]
): string {
  let sanitized = text;

  for (const detail of bashDetails) {
    const output = detail.output.trim();
    if (!output) {
      continue;
    }

    const variants = [
      `\`${output}\``,
      `\`\`\`text\n${output}\n\`\`\``,
      `\`\`\`\n${output}\n\`\`\``,
      output
    ];

    for (const variant of variants) {
      sanitized = stripStandaloneVariant(sanitized, variant);
    }
  }

  sanitized = sanitized
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return sanitized;
}

function stripStandaloneVariant(text: string, variant: string): string {
  const trimmedVariant = variant.trim();
  if (trimmedVariant.length === 0) {
    return text;
  }

  if (text.trim() === trimmedVariant) {
    return '';
  }

  const escapedVariant = escapeRegex(trimmedVariant);
  return text.replace(new RegExp(`(^|\n)${escapedVariant}(?=\n|$)`, 'g'), '$1');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chunkText(text: string, chunkLength: number): string[] {
  if (text.length === 0) {
    return [''];
  }

  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += chunkLength) {
    chunks.push(text.slice(index, index + chunkLength));
  }

  return chunks;
}

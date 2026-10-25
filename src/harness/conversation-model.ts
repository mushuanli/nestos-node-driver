import type { HarnessHistory } from './contracts';
import { FSError } from '@itookit/vfs-core';
import { toolSummary, type ToolOperation } from './tool-summary';
export interface HarnessMessage {
    id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string; status?: string;
    contentParts?: string[];
    /** Native provenance aligned with contentParts; unknown origins stay visible. */
    contentPartKinds?: string[];
    turnId?: string; name?: string; input?: string; inputLanguage?: 'bash' | 'json' | 'text';
    timestamp?: number; paths?: string[]; operation?: ToolOperation; commandPreview?: string;
    commandOutput?: import('./contracts').HarnessCommandOutput;
}
export {nativeRequest} from './interactions';
export type {HarnessRequest} from './interactions';
export function nativeMessage(value: unknown, fallback: string, turnId?: string, at?: number): HarnessMessage | undefined {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>, type = String(item.type ?? '');
    const role = type === 'userMessage' ? 'user' : type === 'agentMessage' ? 'assistant' : /Execution|Change|[Tt]oolCall|toolOutput|webSearch|imageGeneration/.test(type) ? 'tool' : 'system';
    if (type === 'toolOutput') return;
    const summary = role === 'tool' ? toolSummary(item, type) : undefined;
    const parts = [...textParts(item.summary), ...textParts(item.content)], content = parts.join('\n');
    const text = summary?.name ?? (typeof item.text === 'string' ? item.text : typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : content);
    if (!text) return;
    return {id: typeof item.id === 'string' ? item.id : fallback, role, text, turnId: typeof item.turnId === 'string' ? item.turnId : turnId,
        timestamp: messageTime(item.timestamp ?? item.createdAt ?? item.startedAt) ?? at,
        status: typeof item.status === 'string' ? item.status : undefined,
        ...(role === 'user' && Array.isArray(item.content) && typeof item.text !== 'string'
            ? {contentParts: parts, contentPartKinds: contentKinds(item)} : {}), ...summary};
}
function contentKinds(item: Record<string, unknown>): string[] | undefined {
    const kinds = item.contentItemKinds, content = item.content;
    if (!Array.isArray(kinds) || !Array.isArray(content) || kinds.length !== content.length
        || !kinds.every(kind => typeof kind === 'string') || textParts(item.summary).length) return;
    return content.flatMap((part, index) => textParts(part).map(() => kinds[index] as string));
}
export function messageTime(value: unknown): number | undefined {
    const time = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value < 100_000_000_000 ? value * 1000 : value : NaN;
    return Number.isFinite(time) && time > 0 ? time : undefined;
}
function textParts(value: unknown): string[] {
    if (typeof value === 'string') return value ? [value] : [];
    if (Array.isArray(value)) return value.flatMap(textParts);
    if (!value || typeof value !== 'object') return [];
    const part = value as {text?: unknown; content?: unknown};
    return textParts(typeof part.text === 'string' ? part.text : part.content);
}
export function historyMessages(history: HarnessHistory): HarnessMessage[] {
    return boundMessages((history.turns ?? []).flatMap((turn, t) => {
        const row = turn as {id?: unknown; items?: unknown[]; createdAt?: unknown; startedAt?: unknown};
        const turnId = typeof row?.id === 'string' && row.id !== 'rollout-history' ? row.id : undefined;
        const at = messageTime(row.createdAt ?? row.startedAt);
        return Array.isArray(row?.items) ? row.items.flatMap((item, i) => nativeMessage(item, `history:${turnId ?? t}:${i}`, turnId, at) ?? []) : [];
    }));
}

/** Reject capacity overflow explicitly rather than silently deleting requested history. */
export function boundMessages(messages: HarnessMessage[]): HarnessMessage[] {
    const encoder = new TextEncoder();
    if (messages.length > 10_000 || messages.reduce((size, message) => size + encoder.encode(JSON.stringify(message)).byteLength, 0) > 32 * 1024 * 1024) throw new FSError('EFBIG', 'Conversation history capacity reached');
    return messages;
}
export function mergeMessages(first: HarnessMessage[], second: HarnessMessage[]): HarnessMessage[] {
    const messages = [...new Map([...first, ...second].map(message => [message.id, message])).values()];
    if (messages.every(message => message.timestamp !== undefined)) messages.sort((left, right) => left.timestamp! - right.timestamp!);
    return boundMessages(messages);
}

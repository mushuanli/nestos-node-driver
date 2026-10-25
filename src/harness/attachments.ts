import {FSError} from '@itookit/vfs-core';
import type {HarnessAttachment} from './contracts';

export function validateTurnInput(prompt: unknown, attachments: unknown): HarnessAttachment[] {
    validatePrompt(prompt);
    return validateAttachments(attachments);
}

/** Preserve the original composer text separately from the effective native prompt. */
export function prepareTurnInput(text: unknown, value: unknown): {prompt: string; attachments: HarnessAttachment[]} {
    if (typeof text !== 'string') throw invalid('HARNESS_PROMPT_INVALID', 'Native input text must be a string');
    const attachments = validateAttachments(value);
    if (!text.trim() && !attachments.length) throw invalid('HARNESS_PROMPT_INVALID', 'Native input requires text or attachments');
    const prompt = text.trim() || !attachments.length ? text : `Attachments: ${attachments.map(file => file.name).join(', ')}`;
    validatePrompt(prompt);
    return {prompt, attachments};
}

function validatePrompt(prompt: unknown): void {
    if (typeof prompt !== 'string' || !prompt.trim()) throw invalid('HARNESS_PROMPT_INVALID', 'Native prompt must contain text');
    if (prompt.length > 128 * 1024) throw invalid('HARNESS_PROMPT_LIMIT', 'Native prompt exceeds 128 KiB');
    const bytes = new TextEncoder().encode(prompt);
    if (bytes.length > 128 * 1024) throw invalid('HARNESS_PROMPT_LIMIT', 'Native prompt exceeds 128 KiB');
    if (new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes) !== prompt) throw invalid('HARNESS_PROMPT_ENCODING', 'Native prompt must be valid Unicode');
}

/** Mirror the native inline contract before creating or mutating any native session. */
export function validateAttachments(value: unknown): HarnessAttachment[] {
    return attachmentList(value, true);
}

/** Preserve the previously accepted storage contract; validate again before native writes. */
export function readStoredAttachments(value: unknown): HarnessAttachment[] {
    return attachmentList(value, false);
}

function attachmentList(value: unknown, strict: boolean): HarnessAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw invalid('HARNESS_ATTACHMENT_INVALID', 'Expected an attachment list');
    if (value.length > 5) throw invalid('HARNESS_ATTACHMENT_COUNT_LIMIT', 'At most five inline attachments are supported');
    let total = 0;
    for (const file of value) {
        const bytes = validateAttachment(file, strict); total += bytes;
        if (total > 512 * 1024) throw invalid('HARNESS_ATTACHMENT_TOTAL_LIMIT', 'Inline attachments exceed the combined 512 KiB limit');
    }
    return structuredClone(value as HarnessAttachment[]);
}

function validateAttachment(value: unknown, strict: boolean): number {
    if (!value || typeof value !== 'object') throw invalid('HARNESS_ATTACHMENT_INVALID', 'Invalid attachment metadata');
    const file = value as HarnessAttachment;
    if (!['text', 'image'].includes(file.kind) || typeof file.content !== 'string') throw invalid('HARNESS_ATTACHMENT_INVALID', 'Expected inline text or image data');
    validateName(file.name, strict);
    if (file.content.length > 512 * 1024) throw invalid('HARNESS_ATTACHMENT_TOTAL_LIMIT', 'Inline attachment exceeds the combined 512 KiB limit');
    const bytes = new TextEncoder().encode(file.content);
    if (strict && new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes) !== file.content) throw invalid('HARNESS_ATTACHMENT_TEXT_ENCODING', 'Attachment content must be valid Unicode');
    if (file.kind === 'text') validateText(file.content, bytes.length, strict);
    else validateImage(file, strict);
    return bytes.length;
}

function validateName(name: unknown, strict: boolean): void {
    const controls = strict ? /[\x00-\x1f\x7f-\x9f/\\]/ : /[\x00-\x1f\x7f/\\]/;
    if (typeof name !== 'string' || !name || name.length > 256 || controls.test(name))
        throw invalid('HARNESS_ATTACHMENT_NAME_INVALID', 'Attachment names must be nonempty file names without control characters');
    const bytes = new TextEncoder().encode(name);
    if (bytes.length > 256 || strict && new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes) !== name) throw invalid('HARNESS_ATTACHMENT_NAME_INVALID', 'Attachment names must be valid Unicode within 256 UTF-8 bytes');
}

function validateText(content: string, bytes: number, strict: boolean): void {
    if (bytes > 64 * 1024) throw invalid('HARNESS_ATTACHMENT_TEXT_LIMIT', 'Text attachments exceed the per-file 64 KiB limit');
    const controls = strict ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/ : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
    if (controls.test(content)) throw invalid('HARNESS_ATTACHMENT_TEXT_ENCODING', 'Text attachments contain unsupported control characters');
}

function validateImage(file: HarnessAttachment, strict: boolean): void {
    const encoded = imageData(file, strict);
    const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (size > 256 * 1024) throw invalid('HARNESS_ATTACHMENT_IMAGE_LIMIT', 'Inline images exceed the per-file 256 KiB limit');
    if (!strict) return;
    let decoded: string;
    try {decoded = atob(encoded);}
    catch {throw invalid('HARNESS_ATTACHMENT_IMAGE_ENCODING', 'Invalid image base64 data');}
    if (btoa(decoded) !== encoded) throw invalid('HARNESS_ATTACHMENT_IMAGE_ENCODING', 'Invalid image base64 data');
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    if (!imageMagic(bytes, file.mimeType!)) throw invalid('HARNESS_ATTACHMENT_MIME_MISMATCH', 'Image bytes do not match the declared MIME type');
}

function imageData(file: HarnessAttachment, strict: boolean): string {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType ?? '')) throw invalid('HARNESS_ATTACHMENT_FORMAT_UNSUPPORTED', 'Inline images support PNG, JPEG and WebP');
    const prefix = `data:${file.mimeType};base64,`;
    if (!file.content.startsWith(prefix)) throw invalid('HARNESS_ATTACHMENT_MIME_MISMATCH', 'Image MIME type does not match its data URL');
    const encoded = strict ? file.content.slice(prefix.length) : file.content.split(',')[1];
    if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid('HARNESS_ATTACHMENT_IMAGE_ENCODING', 'Invalid image base64 data');
    return encoded;
}

function imageMagic(bytes: Uint8Array, mime: string): boolean {
    if (mime === 'image/png') return starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
    if (mime === 'image/jpeg') return starts(bytes, [255, 216, 255]);
    return starts(bytes, [82, 73, 70, 70]) && starts(bytes.subarray(8), [87, 69, 66, 80]);
}
function starts(bytes: Uint8Array, prefix: number[]): boolean {return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);}
function invalid(attachmentCode: string, reason: string): Error {
    return Object.assign(new FSError('EINVAL', `Invalid native attachment draft: ${reason}`), {
        attachmentCode, remoteCode: attachmentCode, outcome: 'not-committed' as const,
    });
}

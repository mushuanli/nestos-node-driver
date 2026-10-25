import {FSError} from '@itookit/vfs-core';
import {sha256} from '@itookit/vfs-sync';
import type {HarnessCommandOutputRef, HarnessCommandOutputPage, HarnessCommandOutputOptions, HarnessCommandOutputLoadOptions} from './contracts';

const fields = ['version', 'epoch', 'requestId', 'bytes', 'sha256', 'mimeType'];
export const COMMAND_OUTPUT_PREVIEW_BYTES = 64 * 1024;
export const COMMAND_ID_LIMIT = 1024;
const invalid = () => new FSError('EIO', 'Invalid native command output');

export function validateCommandOutputRef(value: unknown): HarnessCommandOutputRef {
    const ref = value as HarnessCommandOutputRef;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(key => !fields.includes(key))
        || !validRefIdentity(ref) || !validRefContent(ref)) throw invalid();
    return {version: 1, epoch: ref.epoch, requestId: ref.requestId, bytes: ref.bytes, sha256: ref.sha256, mimeType: ref.mimeType};
}

function validRefIdentity(ref: HarnessCommandOutputRef): boolean {
    return ref.version === 1 && typeof ref.epoch === 'string' && !!ref.epoch && ref.epoch.length <= 256
        && typeof ref.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(ref.requestId);
}
function validRefContent(ref: HarnessCommandOutputRef): boolean {
    return Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256)
        && ref.mimeType === 'text/plain';
}

export function outputRange(ref: HarnessCommandOutputRef, options?: HarnessCommandOutputOptions): {offset: number; limit: number} {
    const offset = options?.offset ?? 0, limit = options?.limit ?? COMMAND_OUTPUT_PREVIEW_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > ref.bytes || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536)
        throw new FSError('EINVAL', 'Invalid native command output range');
    return {offset, limit};
}

export function validateCommandOutputPage(value: unknown, expected: HarnessCommandOutputRef, options?: HarnessCommandOutputOptions): HarnessCommandOutputPage {
    const page = value as HarnessCommandOutputPage, {offset, limit} = outputRange(expected, options);
    const ref = validateCommandOutputRef(page?.ref);
    if (!fields.every(key => ref[key as keyof HarnessCommandOutputRef] === expected[key as keyof HarnessCommandOutputRef]) || page.offset !== offset)
        throw invalid();
    const bytes = decodeCommandOutputData(page.data);
    const end = offset + bytes.byteLength, nextOffset = end === ref.bytes ? null : end;
    if (bytes.length > limit || end > ref.bytes || !bytes.length && offset !== ref.bytes || page.nextOffset !== nextOffset) throw invalid();
    return {ref, offset, data: page.data, nextOffset};
}

export function decodeCommandOutputData(value: unknown): Uint8Array<ArrayBuffer> {
    if (typeof value !== 'string' || value.length > 87384 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid();
    let decoded: string;
    try {decoded = atob(value);} catch {throw invalid();}
    if (btoa(decoded) !== value) throw invalid();
    return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

export async function loadCommandOutput(ref: HarnessCommandOutputRef,
    read: (options: HarnessCommandOutputOptions) => Promise<HarnessCommandOutputPage>, options?: HarnessCommandOutputLoadOptions): Promise<ArrayBuffer> {
    ref = validateCommandOutputRef(ref);
    const maxBytes = options?.maxBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 32 * 1024 * 1024 || ref.bytes > maxBytes)
        throw new FSError('EFBIG', 'Native command output exceeds the download budget');
    const bytes = new Uint8Array(ref.bytes); let offset = 0;
    do {
        options?.signal?.throwIfAborted();
        const range = {offset, limit: 65536, signal: options?.signal};
        const page = validateCommandOutputPage(await read(range), ref, range), part = decodeCommandOutputData(page.data);
        options?.signal?.throwIfAborted(); bytes.set(part, offset); offset += part.length;
        if (page.nextOffset === null) break;
    } while (offset < ref.bytes);
    if (offset !== ref.bytes || await sha256(bytes) !== ref.sha256) throw new FSError('EIO', 'Native command output integrity mismatch');
    options?.signal?.throwIfAborted(); return bytes.buffer;
}

export function previewOutput(text: string): {text: string; bytes: number; truncated: boolean} {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= COMMAND_OUTPUT_PREVIEW_BYTES) return {text, bytes: bytes.length, truncated: false};
    let end = COMMAND_OUTPUT_PREVIEW_BYTES;
    while ((bytes[end] & 0xc0) === 0x80) --end;
    return {text: new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes.subarray(0, end)), bytes: bytes.length, truncated: true};
}

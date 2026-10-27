import { readExports, supportsMutations } from './protocol/exports';
export type { RemoteExport } from './protocol/exports';
import { checkOperation, FileStorageAdapter, FSError, createFileSystemSource,
    type FileStorageBackend, type FileReader, type FileMutations, type OperationOptions, type FilePage, type FileListOptions, type FileReadOptions } from '@itookit/vfs-core';
import { HttpTransport, type HttpConnectionOptions } from './transport';
import { StatBatch } from './stat-batch';
import { validateStat } from './protocol/stat';

export interface HttpFileSourceOptions extends HttpConnectionOptions { alias: string; }
export class HttpFSBackend implements FileStorageBackend {
    readonly name = 'http';
    private initialized = false;
    readonly files: FileReader;
    mutations?: FileMutations;
    private readonly http: HttpTransport;
    private readonly base: string;
    constructor(private readonly options: HttpFileSourceOptions) {
        if (!/^[a-zA-Z0-9_-]+$/.test(options.alias)) throw new FSError('EINVAL', 'Invalid export alias');
        this.http = new HttpTransport(options); this.base = `v1/fs/${options.alias}`;
        const batch = new StatBatch(this.http, `${this.base}/stat`);
        this.files = { stat: (path, opts) => batch.get(validPath(path), opts),
            statType: (path, opts) => batch.get(validPath(path), opts),
            list: (path, opts) => this.list(path, opts), read: (path, opts) => this.read(path, opts) };
    }
    async init(options?: OperationOptions): Promise<void> {
        checkOperation(options); if (this.initialized) return;
        const exports = await readExports(this.http, options);
        const target = exports.find(item => item.alias === this.options.alias);
        if (!target) throw new FSError('EACCES', 'Export unavailable');
        if (supportsMutations(target)) this.mutations = this.createMutations(target.metadata === true);
        this.initialized = true;
    }
    async close(): Promise<void> { this.http.close(); }
    operationStatus(id: string, options?: OperationOptions) {
        return this.http.json<{ outcome: string; result?: unknown; code?: string }>(`${this.base}/operations/${encodeURIComponent(id)}`, {}, options);
    }
    private createMutations(metadata: boolean): FileMutations {
        const command = (action: string, path: string, extra: object, options?: OperationOptions) =>
            this.http.mutate(`${this.base}/mutate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, path: validPath(path), ...extra }) }, `${this.base}/operations`, options);
        return {
            ...(metadata ? {updateMetadata: async (path: string, patch: Record<string, unknown>, options?: OperationOptions) => {
                const values = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
                const removeKeys = Object.keys(patch).filter(key => patch[key] === undefined);
                await command('metadata', path, {metadata: values, removeKeys}, options);
            }} : {}),
            replace: async (path, data, condition, options) => {
                const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
                headers.set(condition.kind === 'create-only' ? 'If-None-Match' : 'If-Match', condition.kind === 'create-only' ? '*' : condition.revision);
                const result = await this.http.mutate<import('@itookit/vfs-core').FileStat>(`${this.base}/content?${new URLSearchParams({ path: validPath(path) })}`,
                    { method: 'PUT', headers, body: data.slice().buffer }, `${this.base}/operations`, options);
                validateStat(result);
                if (!result) throw new FSError('EIO', 'Missing replacement attributes');
                return result;
            },
            mkdir: async (path, options) => { await command('mkdir', path, {}, options); return { kind: 'directory' }; },
            rename: async (path, to, options) => { await command('rename', path, { to: validPath(to) }, options); },
            remove: async (path, options) => { await command('remove', path, { recursive: options?.recursive ?? false }, options); },
        };
    }
    private async list(path: string, options?: FileListOptions): Promise<FilePage> {
        const query = new URLSearchParams({ path: validPath(path) });
        if (options?.cursor) query.set('cursor', options.cursor);
        const page = await this.http.json<FilePage>(`${this.base}/entries?${query}`, {}, options);
        if (!page || !Array.isArray(page.entries) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new FSError('EIO', 'Invalid directory response');
        for (const entry of page.entries) { validName(entry?.name); validateStat(entry?.stat);
            if (!entry.stat) throw new FSError('EIO', 'Missing child attributes'); }
        return page;
    }
    private async read(path: string, options?: FileReadOptions) {
        checkOperation(options);
        const offset = options?.offset ?? 0, length = options?.length;
        if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) throw new FSError('EINVAL', 'Invalid read range');
        validPath(path);
        if (length !== undefined && !Number.isSafeInteger(offset + length)) throw new FSError('EINVAL', 'Read range overflow');
        if (length === 0) return { data: new Uint8Array() };
        const headers = new Headers();
        if (offset || length !== undefined) headers.set('Range', `bytes=${offset}-${length === undefined ? '' : offset + length - 1}`);
        if (options?.ifRevision) headers.set('If-Match', options.ifRevision);
        const result = await this.http.content(`${this.base}/content?${new URLSearchParams({ path: validPath(path) })}`, { headers }, options);
        if (headers.has('Range')) {
            const range = result.range?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
            const start = range ? Number(range[1]) : -1, end = range ? Number(range[2]) : -1;
            const expectedEnd = length === undefined ? undefined : offset + length - 1;
            // The response must match what this read asked for, not merely be self-consistent:
            // a short or over-long slice is a server fault, never a valid shorter read.
            if (result.status !== 206 || !range || start !== offset || end - start + 1 !== result.data.length
                || (expectedEnd !== undefined && (end !== expectedEnd || result.data.length !== length))
                || Number(range[3]) < end + 1)
                throw new FSError('EIO', 'Unexpected range response');
        }
        if (options?.ifRevision && result.revision !== options.ifRevision) throw new FSError('ECONFLICT', 'Read revision changed');
        return { data: result.data, revision: result.revision };
    }
}

export async function openHttpFileSource(options: HttpFileSourceOptions, viewId = `http:${options.alias}`) {
    const backend = new HttpFSBackend(options);
    try { await backend.init(); } catch (error) { await backend.close(); throw error; }
    return createFileSystemSource({ backend: new FileStorageAdapter(backend), viewId, access: backend.mutations ? 'rw' : 'ro', tags: false });
}

function validPath(path: string): string {
    if (typeof path !== 'string' || new TextEncoder().encode(path).length > 4096 || path.startsWith('/') || /[\\\0]/.test(path)) throw invalidPath();
    const parts = path.split('/');
    if (parts.some(part => part === '..' || part === '.')) throw invalidPath();
    // Only a platform path prefix is rejected; a colon inside a name (`2024:Q1.md`) is a legal
    // export-relative name and must not hide a whole directory.
    if (/^[a-zA-Z]:/.test(parts[0] ?? '')) throw invalidPath();
    return path;
}

/** Directory entries are single names, never paths, so the drive-prefix rule does not apply. */
function validName(name: unknown): void {
    if (typeof name !== 'string' || !name || name.includes('/') || /[\\\0]/.test(name) || name === '.' || name === '..')
        throw new FSError('EIO', 'Invalid child name');
}

function invalidPath() { return new FSError('EINVAL', 'Expected an export-relative path'); }

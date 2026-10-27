import { describe, it, expect } from 'vitest';
import { HttpFSBackend, openHttpFileSource } from '../../src/files';

const config = { endpoint: 'https://files.example/', alias: 'docs', credential: () => 'secret' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
/** A writable export: strong revisions require a declared, supported name equivalence. */
const writableExport = (extra: object = {}) =>
    json({ version: 1, exports: [{ alias: 'docs', access: 'rw', strongRevision: true, nameSemantics: 'source', ...extra }] });

describe('HTTP driver', () => {
    it('carries the read revision through a file handle and never replays a failed write', async () => {
        let revision = '"epoch:1"', writes = 0;
        const fetch: typeof globalThis.fetch = async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith('/exports')) return writableExport();
            if (path.endsWith('/stat')) return json({ results: JSON.parse(String(init?.body)).paths.map((p: string) => ({ stat: { kind: p ? 'file' : 'directory', revision } })) });
            if (init?.method === 'PUT') {
                writes++;
                expect(new Headers(init.headers).get('if-match')).toBe('"epoch:1"');
                return new Response(JSON.stringify({ outcome: 'not-committed', code: 'ECONFLICT' }), { status: 412 });
            }
            return new Response('old content', { headers: { etag: revision } });
        };
        const owner = await openHttpFileSource({ ...config, fetch });
        const { createFile } = await import('@itookit/vfs-core');
        const file = createFile(owner.fs, '/note');
        await file.read(); revision = '"epoch:2"';
        await expect(file.write('new')).rejects.toMatchObject({ code: 'ECONFLICT', outcome: 'not-committed' });
        expect(writes).toBe(1); await owner.dispose();
    });
    it('reports unknown with an operation ID when a write response is lost', async () => {
        let writes = 0;
        const backend = new HttpFSBackend({ ...config, fetch: async (input, init) => {
            if (String(input).endsWith('/exports')) return writableExport();
            if (init?.method === 'PUT') { writes++; throw new TypeError('connection lost'); }
            return json({ outcome: 'committed' });
        } });
        await backend.init();
        await expect(backend.mutations!.replace('note', new Uint8Array(), { kind: 'match', revision: '"old"' }))
            .rejects.toMatchObject({ outcome: 'unknown', operationId: expect.any(String) });
        expect(writes).toBe(1); await backend.close();
    });
    it('batches prefix stats and keeps a cancelled subscriber isolated', async () => {
        const bodies: unknown[] = []; let unblock!: () => void;
        const fetch: typeof globalThis.fetch = async (_url, init) => {
            bodies.push(JSON.parse(String(init!.body)));
            await new Promise<void>(resolve => { unblock = resolve; });
            expect(init!.signal!.aborted).toBe(false);
            return json({ results: [{ stat: { kind: 'directory' } }, { stat: { kind: 'file', size: 4 } }] });
        };
        const backend = new HttpFSBackend({ ...config, fetch });
        const controller = new AbortController();
        const a = expect(backend.files.stat('a', { signal: controller.signal })).rejects.toMatchObject({ code: 'ECANCELLED' });
        const b = backend.files.stat('a/b');
        await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(); unblock();
        await a; expect((await b)?.kind).toBe('file'); expect(bodies).toEqual([{ paths: ['a', 'a/b'] }]);
        await backend.close();
    });
    it('authenticates without putting credentials in URLs and returns binary content', async () => {
        const fetch: typeof globalThis.fetch = async (input, init) => {
            expect(String(input)).not.toContain('secret'); expect(init?.redirect).toBe('error');
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
            const path = new URL(String(input)).pathname;
            if (path.endsWith('/exports')) return json({ version: 1, exports: [{ alias: 'docs', access: 'ro' }] });
            if (path.endsWith('/stat')) return json({ results: JSON.parse(String(init?.body)).paths.map((p: string) => ({ stat: { kind: p ? 'file' : 'directory' } })) });
            return new Response(new Uint8Array([0, 255, 128]));
        };
        const owner = await openHttpFileSource({ ...config, fetch });
        const data = await owner.fs.driver.readContent('/file', { encoding: 'binary' });
        expect([...new Uint8Array(data)]).toEqual([0, 255, 128]);
        await expect(owner.fs.driver.writeContent('/file', 'x')).rejects.toMatchObject({ code: 'EROFS' });
        await owner.dispose();
    });
    it('rejects path traversal, fake range responses and missing permissions', async () => {
        const backend = new HttpFSBackend({ ...config, fetch: async () => new Response('wrong', { status: 200 }) });
        expect(() => backend.files.stat('../escape')).toThrow();
        await expect(backend.files.read('file', { offset: 2, length: 3 })).rejects.toMatchObject({ code: 'EIO' });
        const denied = new HttpFSBackend({ ...config, fetch: async () => new Response('', { status: 403 }) });
        await expect(denied.files.stat('file')).rejects.toMatchObject({ code: 'EACCES' });
        await backend.close(); await denied.close();
    });
    it('rejects a slice that does not match the requested length', async () => {
        const answer = (range: string, bytes: number) => new HttpFSBackend({ ...config,
            fetch: async () => new Response(new Uint8Array(bytes), { status: 206, headers: { 'content-range': range } }) });
        // Requested bytes 2-4 (3 bytes): a short, a long and an unparsable range are all server faults.
        await expect((await answer('bytes 2-3/10', 2)).files.read('file', { offset: 2, length: 3 })).rejects.toMatchObject({ code: 'EIO' });
        await expect((await answer('bytes 2-9/10', 8)).files.read('file', { offset: 2, length: 3 })).rejects.toMatchObject({ code: 'EIO' });
        await expect((await answer('bytes 0-2/10', 3)).files.read('file', { offset: 2, length: 3 })).rejects.toMatchObject({ code: 'EIO' });
        await expect((await answer('bytes 2-4/10', 3)).files.read('file', { offset: 2, length: 3 })).resolves.toMatchObject({ data: expect.any(Uint8Array) });
    });
    it('keeps a definite rejection out of the unknown bucket and does not reconcile it', async () => {
        const requests: string[] = [];
        const backend = new HttpFSBackend({ ...config, fetch: async (input, init) => {
            const path = new URL(String(input)).pathname; requests.push(`${init?.method ?? 'GET'} ${path}`);
            if (path.endsWith('/exports')) return writableExport();
            return new Response('', { status: 412 });
        } });
        await backend.init();
        await expect(backend.mutations!.replace('note', new Uint8Array(), { kind: 'match', revision: '"epoch:1"' }))
            .rejects.toMatchObject({ code: 'ECONFLICT', outcome: 'not-committed' });
        expect(requests.some(entry => entry.includes('/cancel'))).toBe(false);
        await backend.close();
    });
    it('prefers the error body code over the HTTP status and inherits the caller budget in a batch', async () => {
        let timeout = '';
        const backend = new HttpFSBackend({ ...config, fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith('/exports')) return writableExport();
            timeout = new Headers(init?.headers).get('x-timeout-ms') ?? '';
            if (path.endsWith('/stat')) return new Response(JSON.stringify({ code: 'ENOTDIR', message: 'not a directory' }), { status: 400 });
            return new Response('', { status: 400 });
        } });
        await backend.init();
        await expect(backend.files.stat('file/a', { timeoutMs: 3000 })).rejects.toMatchObject({ code: 'ENOTDIR' });
        expect(Number(timeout)).toBeGreaterThan(0); expect(Number(timeout)).toBeLessThanOrEqual(3000);
        await backend.close();
    });
    it('accepts a colon inside a name but rejects a platform path prefix, and keeps unknown name semantics read-only', async () => {
        const paths: string[] = [];
        const backend = new HttpFSBackend({ ...config, fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith('/exports')) return writableExport({ nameSemantics: 'case-folded' });
            paths.push(...JSON.parse(String(init?.body)).paths);
            return json({ results: JSON.parse(String(init?.body)).paths.map((p: string) => ({ stat: { kind: p ? 'file' : 'directory' } })) });
        } });
        await backend.init();
        expect(backend.mutations).toBeUndefined();
        await expect(backend.files.stat('2024:Q1.md')).resolves.toMatchObject({ kind: 'file' });
        expect(() => backend.files.stat('C:/host')).toThrow();
        // Directory entries are names, not paths: the prefix rule must not apply to them.
        expect(paths).toContain('2024:Q1.md');
        await backend.close();
    });
    it('reports a cancellation that happened on the wire as not-committed', async () => {
        const backend = new HttpFSBackend({ ...config, fetch: async (input, init) => {
            if (new URL(String(input)).pathname.endsWith('/exports')) return writableExport();
            return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort',
                () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
        } });
        await backend.init();
        const controller = new AbortController();
        const read = expect(backend.files.read('file', { signal: controller.signal })).rejects.toMatchObject({ code: 'ECANCELLED', outcome: 'not-committed' });
        await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(); await read;
        await backend.close();
    });
});

it('uses UTF-8 Basic credentials for named user/password connections', async () => {
    let authorization = '';
    const backend = new HttpFSBackend({ ...config, username: 'alice', credential: () => 'päss:word', fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization')!;
        return json({ version: 1, exports: [{ alias: 'docs', access: 'ro' }] });
    } });
    await backend.init();
    expect(authorization).toBe('Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode('alice:päss:word'))));
    await backend.close();
});

it('does not expire longer stat subscribers with the shortest batch deadline', async () => {
    let complete!: (response: Response) => void;
    let signal!: AbortSignal;
    const backend = new HttpFSBackend({ ...config, fetch: async (_url, init) => {
        signal = init!.signal!;
        return new Promise(resolve => { complete = resolve; });
    } });
    const short = expect(backend.files.stat('a', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    const long = backend.files.stat('b', { timeoutMs: 5000 });
    await short;
    expect(signal.aborted).toBe(false);
    complete(json({ results: [{ stat: { kind: 'file' } }, { stat: { kind: 'directory' } }] }));
    await expect(long).resolves.toMatchObject({ kind: 'directory' });
    await backend.close();
});

it.each([null, { version: 1, exports: [null] }, { version: 1, exports: [{ alias: '../escape' }] }])
('rejects malformed export discovery as a protocol error', async payload => {
    const backend = new HttpFSBackend({ ...config, fetch: async () => json(payload) });
    await expect(backend.init()).rejects.toMatchObject({ code: 'EIO', operation: 'protocol' });
    await backend.close();
});

it('does not classify a malformed successful write response as not-committed', async () => {
    const backend = new HttpFSBackend({ ...config, fetch: async url => String(url).endsWith('/exports') ? writableExport() : new Response('broken') });
    await backend.init();
    await expect(backend.mutations!.replace('file', new Uint8Array(), { kind: 'create-only' }))
        .rejects.toMatchObject({ outcome: 'unknown' });
    await backend.close();
});

it('rejects missing list attributes instead of exposing invalid directory entries', async () => {
    const backend = new HttpFSBackend({ ...config, fetch: async () => json({ entries: [{ name: 'bad', stat: null }], nextCursor: null }) });
    await expect(backend.files.list('')).rejects.toMatchObject({ code: 'EIO' });
    await backend.close();
});

it('keeps metadata on the remote source across different mount depths, with normal readonly guards', async () => {
    const {createFileSystemView} = await import('@itookit/vfs-core');
    const stored = new Map<string, Record<string, unknown>>(), mutations: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/exports')) return writableExport({metadata: true});
        const body = JSON.parse(String(init?.body));
        if (url.pathname.endsWith('/stat')) return json({results: body.paths.map((path: string) => ({stat: {
            kind: path.endsWith('.md') ? 'file' : 'directory', metadata: stored.get(path) ?? {}, revision: 'original',
        }}))});
        if (url.pathname.endsWith('/mutate')) {
            expect(body.action).toBe('metadata'); expect(body.path).toBe('nested/note.md'); mutations.push(body.path);
            const value = {...stored.get(body.path), ...body.metadata}; body.removeKeys.forEach((key: string) => delete value[key]); stored.set(body.path, value);
            return json({outcome: 'committed', result: {}});
        }
        throw new Error('Unexpected transport request');
    };
    const first = await openHttpFileSource({...config, fetch}), second = await openHttpFileSource({...config, fetch});
    const nested = createFileSystemView({viewId: 'nested', mounts: [{mountId: 'remote', at: '/workspace', root: '/nested', fs: second.fs, access: 'rw'}]});
    const readonly = createFileSystemView({viewId: 'readonly', mounts: [{mountId: 'remote', at: '/', fs: second.fs, access: 'ro'}]});
    try {
        await first.fs.driver.updateMetadata('/nested/note.md', {_custom: {anchor: 'a'}, other: 1});
        expect((await nested.driver.getNode('/workspace/note.md'))?.metadata._custom).toEqual({anchor: 'a'});
        await nested.driver.updateMetadata('/workspace/note.md', {other: undefined});
        expect((await first.fs.driver.getNode('/nested/note.md'))?.metadata).toEqual({_custom: {anchor: 'a'}});
        await expect(readonly.driver.updateMetadata('/nested/note.md', {x: 1})).rejects.toMatchObject({code: 'EROFS'});
        expect(mutations).toHaveLength(2);
    } finally {await nested.dispose(); await readonly.dispose(); await first.dispose(); await second.dispose();}
});

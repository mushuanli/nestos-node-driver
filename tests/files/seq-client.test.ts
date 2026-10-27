import { expect, it, vi } from 'vitest';
import { HttpSeqClient } from '../../src/files/seq/client';

it('sends structured SQLite SeqFile transactions with explicit revisions', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (String(_url).endsWith('/snapshot')) return Response.json({ revision: 'old', entries: [{ key: 'identity', value: { id: 'project' } }] });
        const input = JSON.parse(String(init?.body));
        expect(input.expectedRevision).toBe('old');
        return Response.json({ outcome: 'committed', result: { revision: 'new' } });
    });
    const client = new HttpSeqClient({ endpoint: 'http://localhost/', alias: 'docs', credential: () => 'secret', fetch });
    try {
        const snapshot = await client.snapshot('/.nestos/info.seq');
        expect(snapshot.entries[0].value).toEqual({ id: 'project' });
        expect(await client.transaction('/.nestos/info.seq', snapshot.revision, [{ action: 'set', key: 'title', value: 'Name' }]))
            .toEqual({ revision: 'new' });
        expect(new Headers(fetch.mock.calls[1][1]?.headers).get('x-operation-id')).toBeTruthy();
        await expect(client.snapshot('../escape.seq')).rejects.toMatchObject({ code: 'EINVAL' });
    } finally { client.dispose(); }
});


it('does not replay a SeqFile transaction whose server result is unknown', async () => {
    const routes: string[] = [];
    const fetch = vi.fn(async (url: unknown) => {
        routes.push(String(url));
        return Response.json({ outcome: 'unknown' }, { status: 504 });
    });
    const client = new HttpSeqClient({ endpoint: 'http://localhost/', alias: 'docs', credential: () => 'secret', fetch });
    try {
        await expect(client.transaction('info.seq', null, [])).rejects.toMatchObject({ outcome: 'unknown' });
        expect(routes.filter(route => route.endsWith('/seq/transaction'))).toHaveLength(1);
    } finally { client.dispose(); }
});

it('rejects malformed SeqFile snapshots and committed revision results', async () => {
    const client = new HttpSeqClient({ endpoint: 'http://localhost/', alias: 'docs', credential: () => 'secret',
        fetch: async url => Response.json(String(url).endsWith('/snapshot') ? null : { outcome: 'committed', result: {} }) });
    try {
        await expect(client.snapshot('info.seq')).rejects.toMatchObject({ code: 'EIO' });
        await expect(client.transaction('info.seq', null, [])).rejects.toMatchObject({ code: 'EIO' });
    } finally { client.dispose(); }
});

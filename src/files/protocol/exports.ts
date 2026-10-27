import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { HttpTransport } from '../transport';

export interface RemoteExport { alias: string; access?: 'ro' | 'rw'; nameSemantics?: string; strongRevision?: boolean; metadata?: boolean; }

export async function readExports(http: HttpTransport, options?: OperationOptions): Promise<RemoteExport[]> {
    const value = await http.json<{ version: number; exports: RemoteExport[] }>('v1/exports', {}, options);
    if (!value || value.version !== 1 || !Array.isArray(value.exports)
        || value.exports.some(item => !item || typeof item.alias !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item.alias)
            || (item.access !== undefined && item.access !== 'ro' && item.access !== 'rw') || (item.metadata !== undefined && typeof item.metadata !== 'boolean')))
        throw new FSError('EIO', 'Invalid file server response', 'protocol');
    if (new Set(value.exports.map(item => item.alias)).size !== value.exports.length)
        throw new FSError('EIO', 'Duplicate export alias', 'protocol');
    return value.exports;
}

/** Writable support requires a revision scheme that understands source name equivalence. */
export function supportsMutations(target: RemoteExport): boolean {
    return target.access === 'rw' && target.strongRevision === true && target.nameSemantics === 'source';
}

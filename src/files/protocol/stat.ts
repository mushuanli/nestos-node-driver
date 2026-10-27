import { FSError, type FileStat } from '@itookit/vfs-core';

export function validateStat(value: unknown): asserts value is FileStat | null {
    if (value === null) return;
    const stat = value as FileStat | undefined;
    if (!stat || !['file', 'directory', 'symlink'].includes(stat.kind)
        || (stat.sourceIdentity !== undefined && (typeof stat.sourceIdentity !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(stat.sourceIdentity)))
        || (stat.metadata !== undefined && (!stat.metadata || typeof stat.metadata !== 'object' || Array.isArray(stat.metadata)))
        || (stat.size !== undefined && (!Number.isSafeInteger(stat.size) || stat.size < 0))) throw new FSError('EIO', 'Invalid remote file attributes');
}

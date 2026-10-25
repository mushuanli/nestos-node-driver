import {FSError} from '@itookit/vfs-core';
import type {HarnessForkResult} from './contracts';
import {validateSession} from './validation';

export interface ForkCheckpoint {sourceSessionId: string; turnId: string}
export interface HarnessForkReceipt extends ForkCheckpoint {requestId: string; sessionId: string; verified: boolean; code?: string}

/** A committed fork reply with failed proof never authorizes a context switch. */
export function validateForkResult(value: unknown, sourceSessionId: string, turnId?: string): HarnessForkResult {
    const result = value as HarnessForkResult, session = validateSession(result?.session);
    if (turnId === undefined) return {session};
    const proof = result?.checkpoint;
    const identity = proof?.sourceSessionId === sourceSessionId && proof?.turnId === turnId && session.id !== sourceSessionId;
    const verified = identity && proof?.verified === true;
    const code = verified ? undefined : checkpointFailureCode(proof, identity);
    return {session, checkpoint: {sourceSessionId, turnId, verified, ...(code ? {code} : {})}};
}
function checkpointFailureCode(proof: HarnessForkResult['checkpoint'], identity: boolean): string {
    if (!proof || typeof proof.verified !== 'boolean') return 'HARNESS_CHECKPOINT_BOUNDARY_UNKNOWN';
    if (!identity) return 'HARNESS_CHECKPOINT_BOUNDARY_MISMATCH';
    return typeof proof.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(proof.code) ? proof.code : 'HARNESS_CHECKPOINT_BOUNDARY_UNKNOWN';
}

export function forkReceipt(requestId: string, sourceSessionId: string, result: unknown, checkpoint?: ForkCheckpoint): HarnessForkReceipt {
    const value = validateForkResult(result, sourceSessionId, checkpoint?.turnId);
    const verified = value.session.id !== sourceSessionId && (!checkpoint || value.checkpoint?.verified === true);
    return {requestId, sourceSessionId, sessionId: value.session.id, turnId: checkpoint?.turnId ?? '', verified,
        ...(!verified ? {code: value.checkpoint?.code ?? 'HARNESS_CHECKPOINT_FORK_IDENTITY'} : {})};
}

export function validateForkReceipt(value: HarnessForkReceipt | undefined): HarnessForkReceipt | undefined {
    if (value === undefined) return;
    if (!value || ![value.requestId, value.sourceSessionId, value.sessionId].every(id => typeof id === 'string' && !!id)
        || typeof value.turnId !== 'string' || typeof value.verified !== 'boolean'
        || value.code !== undefined && !/^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)) throw new FSError('EIO', 'Invalid native fork receipt');
    return {requestId: value.requestId, sourceSessionId: value.sourceSessionId, sessionId: value.sessionId,
        turnId: value.turnId, verified: value.verified, ...(value.code ? {code: value.code} : {})};
}

export function validateForkCheckpoint(value: ForkCheckpoint | undefined): ForkCheckpoint | undefined {
    if (value === undefined) return;
    if (!value || typeof value.sourceSessionId !== 'string' || !value.sourceSessionId || typeof value.turnId !== 'string'
        || !value.turnId || value.turnId.length > 256) throw new FSError('EIO', 'Invalid pending native fork checkpoint');
    return {sourceSessionId: value.sourceSessionId, turnId: value.turnId};
}

export function forkFailure(receipt: HarnessForkReceipt | undefined): FSError | undefined {
    if (!receipt || receipt.verified) return;
    return Object.assign(new FSError('ECONFLICT', `Native checkpoint fork was not selected: ${receipt.code}`),
        {outcome: 'committed', remoteCode: receipt.code, requestId: receipt.requestId, nativeSessionId: receipt.sessionId});
}

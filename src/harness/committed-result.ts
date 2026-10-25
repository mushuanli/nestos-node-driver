import {FSError} from '@itookit/vfs-core';
import type {HarnessReceipt} from './contracts';
const receipts = new WeakMap<object, HarnessReceipt>();

/** A malformed result cannot revoke the gateway's confirmed mutation receipt. */
export function decodeCommittedResult<T>(receipt: HarnessReceipt, decode: (value: unknown) => T): T {
    try {return decode(receipt.result);}
    catch (cause) {
        const failure = Object.assign(new FSError('EIO', 'Native operation committed but its result is invalid'),
            {outcome: 'committed' as const, requestId: receipt.requestId, remoteCode: 'HARNESS_COMMITTED_RESULT_INVALID'});
        receipts.set(failure, receipt);
        Object.defineProperty(failure, 'cause', {value: cause});
        throw failure;
    }
}

export function committedReceipt(error: unknown): HarnessReceipt | undefined {
    if (!error || typeof error !== 'object' || (error as {outcome?: string}).outcome !== 'committed') return;
    const receipt = receipts.get(error);
    return receipt?.outcome === 'committed' ? receipt : undefined;
}

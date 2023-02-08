import { isFunction } from './is';
import type { ListenerFn, ListenerParams } from './observableInterfaces';

interface BatchItem {
    cb: ListenerFn<any>;
    params: ListenerParams<any>;
}
let timeout: ReturnType<typeof setTimeout> | undefined;
let numInBatch = 0;
let _batch: (BatchItem | (() => void))[] = [];
let _afterBatch: (() => void)[] = [];
// Use a Map of callbacks for fast lookups to update the BatchItem
let _batchMap = new Map<ListenerFn, BatchItem | true>();

function onActionTimeout() {
    if (_batch.length > 0) {
        if (process.env.NODE_ENV === 'development') {
            console.error(
                'Forcibly completing observableBatcher because end() was never called. This may be due to an uncaught error between begin() and end().'
            );
        }
        endBatch(/*force*/ true);
    }
}

export function batchNotify(b: BatchItem | (() => void)) {
    const isFunc = isFunction(b);
    const cb = isFunc ? b : b.cb;
    if (numInBatch > 0) {
        const existing = _batchMap.get(cb);
        const it = isFunc ? true : b;
        // If this callback already exists, make sure it has the latest value but do not add it
        if (existing) {
            if (!isFunc) {
                const params = (existing as BatchItem).params;
                params.value = b.params.value;
                params.changes.push(...b.params.changes);
            }
        } else {
            _batch.push(b);
            _batchMap.set(cb, it);
        }
    } else {
        isFunc ? b() : b.cb(b.params);
    }
}

export function batch(fn: () => void, after?: () => void) {
    if (after) {
        _afterBatch.push(after);
    }
    beginBatch();
    fn();
    endBatch();
}
export function beginBatch() {
    numInBatch++;
    // Set a timeout to call end() in case end() is never called or there's an uncaught error
    if (!timeout) {
        timeout = setTimeout(onActionTimeout, 0);
    }
}
export function endBatch(force?: boolean) {
    numInBatch--;
    if (numInBatch <= 0 || force) {
        clearTimeout(timeout);
        timeout = undefined;
        numInBatch = 0;
        // Save batch locally and reset _batch first because a new batch could begin while looping over callbacks.
        // This can happen with observableComputed for example.
        const batch = _batch;
        const after = _afterBatch;
        _batch = [];
        _batchMap = new Map();
        _afterBatch = [];
        for (let i = 0; i < batch.length; i++) {
            const b = batch[i];
            if (isFunction(b)) {
                b();
            } else {
                const { cb } = b;
                cb(b.params);
            }
        }
        for (let i = 0; i < after.length; i++) {
            after[i]();
        }
    }
}

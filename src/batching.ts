import { isFunction } from './is';
import type { ListenerFn, NodeValue } from './observableInterfaces';

interface BatchItem {
    cb: ListenerFn<any>;
    value: any;
    getPrevious?: () => any;
    changes: {
        path: (string | number)[];
        valueAtPath: any;
        prevAtPath: any;
    }[];
    node?: NodeValue;
}
let timeout: ReturnType<typeof setTimeout> | undefined;
let numInBatch = 0;
let _batch: (BatchItem | (() => void))[] = [];
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
                (existing as BatchItem).value = b.value;
                (existing as BatchItem).changes.push(...b.changes);
            }
        } else {
            _batch.push(b);
            _batchMap.set(cb, it);
        }
    } else {
        isFunc ? b() : b.cb(b.value, b.getPrevious, b.changes, b.node);
    }
}

export function batch(fn: () => void) {
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
        _batch = [];
        _batchMap = new Map();
        for (let i = 0; i < batch.length; i++) {
            const b = batch[i];
            if (isFunction(b)) {
                b();
            } else {
                const { cb, value, getPrevious: prev, changes, node } = b;
                cb(value, prev, changes, node);
            }
        }
    }
}

import { getNode, lockObservable } from './helpers';
import { isPromise } from './is';
import { observable } from './observable';
import { ObservableComputed } from './observableInterfaces';
import { observe } from './observe';

export function computed<T>(compute: () => T | Promise<T>): ObservableComputed<T> {
    // Create an observable for this computed variable
    const obs = observable<T>();
    lockObservable(obs, true);

    // Lazily activate the observable when get is called
    getNode(obs).root.activate = () => {
        const set = function (val: any) {
            // Update the computed value
            lockObservable(obs, false);
            obs.set(val);
            lockObservable(obs, true);
        };
        const fn = function () {
            const val = compute();
            if (isPromise<T>(val)) {
                val.then((v) => set(v));
            } else {
                set(val);
            }
        };

        observe(fn);
    };

    return obs as unknown as ObservableComputed<T>;
}

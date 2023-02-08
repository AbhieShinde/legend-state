import { isFunction, observable, Observable, ObservableWriteable, PersistOptions } from '@legendapp/state';
import { persistObservable } from '@legendapp/state/persist';
import { useMemo } from 'react';

/**
 * A React hook that creates a new observable and can optionally listen or persist its state.
 *
 * @param initialValue The initial value of the observable or a function that returns the initial value
 * @param options Persistence options for the observable
 *
 * @see https://www.legendapp.com/dev/state/react/#useObservable
 */
export function usePersistedObservable<T>(
    initialValue?: T | (() => T) | (() => Promise<T>),
    options?: PersistOptions<T>
): Observable<T> {
    // Create the observable from the default value
    return useMemo(() => {
        const obs = observable<T>(
            isFunction(initialValue as () => T) ? (initialValue as () => T)() : (initialValue as T)
        );
        if (options) {
            persistObservable<T>(obs as ObservableWriteable<T>, options);
        }
        return obs;
    }, []) as any;
}

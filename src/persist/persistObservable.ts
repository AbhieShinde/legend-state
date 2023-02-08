import {
    batch,
    beginBatch,
    clone,
    constructObject,
    dateModifiedKey,
    deconstructObject,
    endBatch,
    isEmpty,
    isString,
    mergeIntoObservable,
    observable,
    symbolDateModified,
    tracking,
    when,
} from '@legendapp/state';
import type {
    Change,
    ClassConstructor,
    Observable,
    ObservableObject,
    ObservablePersistLocal,
    ObservablePersistRemote,
    ObservablePersistState,
    ObservableReadable,
    PersistMetadata,
    PersistOptions,
    PersistOptionsLocal,
} from '../observableInterfaces';
import { observablePersistConfiguration } from './configureObservablePersistence';
import { invertFieldMap, transformObject, transformPath } from './fieldTransformer';
import { removeNullUndefined, replaceKeyInObject } from './persistHelpers';

export const mapPersistences: WeakMap<
    ClassConstructor<ObservablePersistLocal | ObservablePersistRemote>,
    ObservablePersistLocal | ObservablePersistRemote
> = new WeakMap();

export const persistState = observable({ inRemoteSync: false });

interface LocalState {
    persistenceLocal?: ObservablePersistLocal;
    persistenceRemote?: ObservablePersistRemote;
    pendingChanges?: Record<string, { p: any; v?: any }>;
}

function parseLocalConfig(config: string | PersistOptionsLocal): { table: string; config: PersistOptionsLocal } {
    return isString(config) ? { table: config, config: { name: config } } : { table: config.name, config };
}

async function onObsChange<T>(
    obs: Observable<T>,
    obsState: ObservableObject<ObservablePersistState>,
    localState: LocalState,
    persistOptions: PersistOptions<T>,
    value: T,
    getPrevious: () => T,
    changes: Change[]
) {
    const { persistenceLocal, persistenceRemote } = localState;

    const local = persistOptions.local;
    const { table, config } = parseLocalConfig(local);
    const inRemoteChange = tracking.inRemoteChange;
    const saveRemote =
        !inRemoteChange && persistOptions.remote && !persistOptions.remote.readonly && obsState.isEnabledRemote.peek();

    if (local && obsState.isEnabledLocal.peek()) {
        if (!obsState.isLoadedLocal.peek()) {
            console.error(
                '[legend-state] WARNING: An observable was changed before being loaded from persistence',
                local
            );
            return;
        }

        // If saving remotely convert symbolDateModified to dateModifiedKey before saving locally
        // as persisting may not include symbols correctly
        let localValue = value;
        if (persistOptions.remote) {
            if (saveRemote) {
                for (let i = 0; i < changes.length; i++) {
                    const { path, valueAtPath, prevAtPath } = changes[i];
                    if (path[path.length - 1] === (symbolDateModified as any)) continue;
                    const pathStr = path.join('/');

                    if (!localState.pendingChanges) {
                        localState.pendingChanges = {};
                    }
                    // The value saved in pending should be the previous state before changes,
                    // so don't overwrite it if it already exists
                    if (!localState.pendingChanges[pathStr]) {
                        localState.pendingChanges[pathStr] = { p: prevAtPath ?? null };
                    }

                    localState.pendingChanges[pathStr].v = valueAtPath;
                }
            }
        }

        let changesLocal = changes;
        if (config.fieldTransforms) {
            localValue = transformObject(localValue, config.fieldTransforms, [dateModifiedKey]) as T;
            changesLocal = changesLocal.map(({ path, prevAtPath, valueAtPath }) => {
                let transformed = constructObject(path, clone(valueAtPath));
                transformed = transformObject(transformed, config.fieldTransforms, [dateModifiedKey]);
                const transformedPath = transformPath(path as string[], config.fieldTransforms, [dateModifiedKey]);
                const toSave = deconstructObject(transformedPath, transformed);
                return { path, prevAtPath, valueAtPath: toSave };
            });
        }

        localValue = replaceKeyInObject(
            localValue as unknown as object,
            symbolDateModified,
            dateModifiedKey,
            /*clone*/ true
        );

        persistenceLocal.set(table, localValue, changesLocal, config);

        const metadata: PersistMetadata = {};

        if (inRemoteChange) {
            const dateModified = value[symbolDateModified];
            if (dateModified) {
                metadata.modified = dateModified;
            }
        }

        if (localState.pendingChanges !== undefined) {
            metadata.pending = localState.pendingChanges;
        }

        if (!isEmpty(metadata)) {
            persistenceLocal.updateMetadata(table, metadata, config);
        }
    }

    if (saveRemote) {
        await when(obsState.isLoadedRemote);

        for (let i = 0; i < changes.length; i++) {
            const { path, valueAtPath, prevAtPath } = changes[i];
            if (path[path.length - 1] === (symbolDateModified as any)) continue;
            const pathStr = path.join('/');

            // Save to remote persistence and get the remote value from it. Some providers (like Firebase) will return a
            // server value different than the saved value (like Firebase has server timestamps for dateModified)
            persistenceRemote.save(persistOptions, value, path, valueAtPath, prevAtPath).then((saved) => {
                if (local) {
                    let toSave = persistenceLocal.getTable(table, config);
                    const pending = persistenceLocal.getMetadata(table, config)?.pending;
                    let dateModified;
                    let didDelete = false;
                    if (pending?.[pathStr]) {
                        didDelete = true;
                        // Remove pending from the saved object
                        delete pending[pathStr];
                        // Remove pending from local state
                        delete localState.pendingChanges[pathStr];
                    }
                    // Only the latest save will return a value so that it saves back to local persistence once
                    if (saved !== undefined) {
                        onChangeRemote(() => {
                            mergeIntoObservable(obs, saved);
                        });
                        dateModified = saved[symbolDateModified];
                        // Replace the dateModifiedKey and remove null/undefined before saving
                        if (config.fieldTransforms) {
                            saved = transformObject(saved, config.fieldTransforms, [dateModifiedKey]) as T;
                        }
                        saved = replaceKeyInObject(
                            removeNullUndefined(saved as object),
                            symbolDateModified,
                            dateModifiedKey,
                            /*clone*/ false
                        );
                        toSave = toSave ? mergeIntoObservable(toSave, saved) : saved;
                    }
                    if (saved !== undefined || didDelete) {
                        persistenceLocal.set(table, toSave, [changes[i]], config);
                        persistenceLocal.updateMetadata(table, { pending, modified: dateModified }, config);
                    }
                }
            });
        }
    }
}

function onChangeRemote(cb: () => void) {
    // Remote changes should only update local state
    persistState.inRemoteSync.set(true);
    tracking.inRemoteChange = true;

    try {
        beginBatch();
        cb();
    } finally {
        endBatch();
        tracking.inRemoteChange = false;
        persistState.inRemoteSync.set(false);
    }
}

async function loadLocal<T>(
    obs: ObservableReadable<T>,
    persistOptions: PersistOptions,
    obsState: ObservableObject<ObservablePersistState>,
    localState: LocalState
) {
    const { local, remote } = persistOptions;
    const localPersistence: ClassConstructor<ObservablePersistLocal> =
        persistOptions.persistLocal || observablePersistConfiguration.persistLocal;

    if (local) {
        const { table, config } = parseLocalConfig(local);
        if (!localPersistence) {
            throw new Error('Local persistence is not configured');
        }
        // Ensure there's only one instance of the persistence plugin
        if (!mapPersistences.has(localPersistence)) {
            const persistenceLocal = new localPersistence();
            if (persistenceLocal.initialize) {
                await persistenceLocal.initialize?.(observablePersistConfiguration.persistLocalOptions);
            }
            mapPersistences.set(localPersistence, persistenceLocal);
        }
        const persistenceLocal = (localState.persistenceLocal = mapPersistences.get(
            localPersistence
        ) as ObservablePersistLocal);

        // If persistence has an asynchronous load, wait for it
        if (persistenceLocal.loadTable) {
            const promise = persistenceLocal.loadTable(table, config);
            if (promise) {
                await promise;
            }
        }

        // Get the value from state
        let value = persistenceLocal.getTable(table, config);
        const metadata = persistenceLocal.getMetadata(table, config);

        if (config.fieldTransforms) {
            // Get preloaded translated if available
            let valueLoaded = persistenceLocal.getTableTransformed(table, config);
            if (valueLoaded) {
                value = valueLoaded;
            } else {
                const inverted = invertFieldMap(config.fieldTransforms);
                value = transformObject(value, inverted, [dateModifiedKey]);
            }
        }

        if (metadata) {
            const pending = metadata.pending;
            localState.pendingChanges = pending;
        }

        // Merge the data from local persistence into the default state
        if (value !== null && value !== undefined) {
            if (remote) {
                replaceKeyInObject(value, dateModifiedKey, symbolDateModified, /*clone*/ false);
            }
            if (metadata?.modified) {
                value[symbolDateModified] = metadata.modified;
            }
            batch(() => mergeIntoObservable(obs, value));
        }

        obsState.peek().clearLocal = () => persistenceLocal.deleteTable(table, config);
    }
    obsState.isLoadedLocal.set(true);
}

export function persistObservable<T>(obs: ObservableReadable<T>, persistOptions: PersistOptions<T>) {
    const obsState = observable<ObservablePersistState>({
        isLoadedLocal: false,
        isLoadedRemote: false,
        isEnabledLocal: true,
        isEnabledRemote: true,
        clearLocal: undefined,
        sync: () => Promise.resolve(),
    });

    const { remote, local } = persistOptions;
    const remotePersistence = persistOptions.persistRemote || observablePersistConfiguration?.persistRemote;
    const localState: LocalState = {};

    if (local) {
        loadLocal(obs, persistOptions, obsState, localState);
    }

    if (remote) {
        if (!remotePersistence) {
            throw new Error('Remote persistence is not configured');
        }
        // Ensure there's only one instance of the persistence plugin
        if (!mapPersistences.has(remotePersistence)) {
            mapPersistences.set(remotePersistence, new remotePersistence());
        }
        localState.persistenceRemote = mapPersistences.get(remotePersistence) as ObservablePersistRemote;

        let isSynced = false;
        const sync = async () => {
            if (!isSynced) {
                isSynced = true;
                localState.persistenceRemote.listen(
                    obs,
                    persistOptions,
                    () => {
                        obsState.isLoadedRemote.set(true);
                    },
                    onChangeRemote
                );

                await when(obsState.isLoadedRemote);

                const pending = localState.pendingChanges;
                if (pending) {
                    Object.keys(pending).forEach((key) => {
                        const path = key.split('/').filter((p) => p !== '');
                        const { p, v } = pending[key];
                        // TODO getPrevious if any remote persistence layers need it
                        onObsChange(
                            obs as Observable,
                            obsState,
                            localState,
                            persistOptions,
                            obs.peek(),
                            () => undefined,
                            [{ path, valueAtPath: v, prevAtPath: p }]
                        );
                    });
                }
            }
        };

        if (remote.manual) {
            obsState.assign({ sync });
        } else {
            when(() => !local || obsState.isLoadedLocal.get(), sync);
        }
    }

    when(obsState.isLoadedLocal, () => {
        obs.onChange(onObsChange.bind(this, obs, obsState, localState, persistOptions));
    });

    return obsState;
}

import { constructObjectWithPath, mergeIntoObservable } from '@legendapp/state';
import { MMKV } from 'react-native-mmkv';
import type { Change, ObservablePersistLocal, PersistMetadata, PersistOptionsLocal } from '../observableInterfaces';

const symbolDefault = Symbol();

export class ObservablePersistMMKV implements ObservablePersistLocal {
    private data: Record<string, any> = {};
    private storages = new Map<symbol | string, MMKV>([
        [
            symbolDefault,
            new MMKV({
                id: `obsPersist`,
            }),
        ],
    ]);
    public getTable<T = any>(table: string, config: PersistOptionsLocal): T {
        const storage = this.getStorage(config);
        if (this.data[table] === undefined) {
            try {
                const value = storage.getString(table);
                return value ? JSON.parse(value) : undefined;
            } catch {
                console.error('[legend-state] MMKV failed to parse', table);
            }
        }
        return this.data[table];
    }
    public getMetadata(table: string, config: PersistOptionsLocal): PersistMetadata {
        return this.getTable(table + '__m', config);
    }
    public async set(table: string, changes: Change[], config: PersistOptionsLocal): Promise<void> {
        if (!this.data[table]) {
            this.data[table] = {};
        }
        this.data[table] = mergeIntoObservable(
            this.data[table],
            ...changes.map(({ path, valueAtPath, pathTypes }) => constructObjectWithPath(path, valueAtPath, pathTypes))
        );
        this.save(table, config);
    }
    public async updateMetadata(table: string, metadata: PersistMetadata, config: PersistOptionsLocal) {
        return this.setValue(table + '__m', metadata, config);
    }
    public async deleteTable(table: string, config: PersistOptionsLocal): Promise<void> {
        const storage = this.getStorage(config);
        delete this.data[table];
        storage.delete(table);
    }
    // Private
    private getStorage(config: PersistOptionsLocal): MMKV {
        const { mmkv } = config;
        if (mmkv) {
            const key = JSON.stringify(mmkv);
            let storage = this.storages.get(key);
            if (!storage) {
                storage = new MMKV(mmkv);
                this.storages.set(key, storage);
            }
            return storage;
        } else {
            return this.storages.get(symbolDefault);
        }
    }
    private async setValue(table: string, value: any, config: PersistOptionsLocal) {
        this.data[table] = value;
        this.save(table, config);
    }
    private save(table: string, config: PersistOptionsLocal | undefined) {
        const storage = this.getStorage(config);
        const v = this.data[table];
        if (v !== undefined) {
            try {
                storage.set(table, JSON.stringify(v));
            } catch (err) {
                console.error(err);
            }
        } else {
            storage.delete(table);
        }
    }
}

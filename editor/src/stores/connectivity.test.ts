import { describe, it, expect } from 'bun:test';
import { useConnectivityStore } from './connectivity';

describe('connectivity store', () => {
    it('defaults online and toggles', () => {
        expect(useConnectivityStore.getState().online).toBe(true);
        useConnectivityStore.getState().setOnline(false);
        expect(useConnectivityStore.getState().online).toBe(false);
        useConnectivityStore.getState().setOnline(true);
    });
    it('reportFetchFailure flips offline', () => {
        useConnectivityStore.getState().reportFetchFailure();
        expect(useConnectivityStore.getState().online).toBe(false);
        useConnectivityStore.getState().setOnline(true);
    });
});

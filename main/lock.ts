/**
 * A simple asynchronous mutex to serialize ZATCA operations.
 */
class Mutex {
    private mutex = Promise.resolve();

    async acquire(): Promise<() => void> {
        let resolve: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        const prevNodes = this.mutex;
        this.mutex = prevNodes.then(() => promise);
        
        await prevNodes;
        return () => resolve();
    }
}

export const ZatcaLock = new Mutex();

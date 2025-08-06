interface Options {
    baseUrl: string;
    globalInit: RequestInit;
    unsafe: boolean;

    onHttpError?(res: Response, text: string): MaybePromise;
    onNetworkError?(res: Error): MaybePromise;

    fetch(req: Request): Promise<Response>
}

export const options: Options = {
    baseUrl: '',
    unsafe: false,
    globalInit: {},
    fetch: globalThis.fetch.bind(globalThis),
}

type MaybePromise<T = unknown> = T | Promise<T>;

interface Ok<T> {
    success: true;
    value: T;
}

interface Err {
    success: false;
    response: Response;
}

type Result<T> = Ok<T> | Err;
const ok = <T>(value: T) => ({success: true, value} satisfies Ok<T>);
const err = (response: Response) => ({success: false, response} satisfies Err);

const makeQuery = (params: Record<string, any>) =>
    '?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined)));

type RepresentsHeader = Headers | [string, string][] | Record<string, string>;

const jsonContentTypeHeader = (
    firstInit?: RepresentsHeader,
    secondInit?: RepresentsHeader,
) => {
    const firstHeaders = new Headers(firstInit);
    const secondHeaders = new Headers(secondInit);
    const headers = new Headers([
        ...Array.from(firstHeaders.entries()),
        ...Array.from(secondHeaders.entries()),
    ]);

    headers.set('Content-Type', 'application/json');
    return headers;
};

const run = async <T extends Array<unknown>, R>(fn: (...args: T) => R, ...args: T): Promise<R | null> => {
    try {
        return await fn(...args);
    } catch (e) {
        console.error(e);
        return null;
    }
}

class PromiseWrapper<T> implements PromiseLike<T> {
    private isDebug = false;

    /** @deprecated Use {@link PromiseWrapper.clear} */
    silent() {
        return this.clear();
    }

    clear() {
        this.httpFailureCallbacks.length = 0;
        this.networkErrorCallbacks.length = 0;
        return this;
    }

    debug(isDebug: boolean = true) {
        this.isDebug = isDebug;
        return this;
    }

    public then<TResult1 = T, TResult2 = never>(
        onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this.promise.then(onFulfilled, onRejected)
    }

    public readonly promise: Promise<T>

    constructor(promise: Promise<Result<T>>) {
        if (options.onHttpError) {
            this.httpFailureCallbacks.push(options.onHttpError)
        }
        if (options.onNetworkError) {
            this.networkErrorCallbacks.push(options.onNetworkError)
        }

        this.promise = promise.then((res) => res.success ? res.value : Promise.reject(res.response))

        promise
            .then(
                async (res) => {
                    if (res.success) {
                        this.isDebug && console.info(res.value);

                        await Promise.all(this.successCallbacks.map((fn) => run(fn, res.value)));
                    } else {
                        const cloned = res.response.clone();

                        const text = await cloned.text();
                        this.isDebug && console.warn(res.response, text);

                        await Promise.all(this.httpFailureCallbacks.map((fn) => run(fn, res.response, text)));
                    }
                },
                async (e) => {
                    this.isDebug && console.error(e);

                    let error = e instanceof Error ? e : new Error(e);

                    await Promise.all(this.networkErrorCallbacks.map((fn) => run(fn, error)));
                },
            )
            .catch(console.error)
            .finally(() => {
                this.finallyCallbacks.forEach(run);
            });
    }

    private successCallbacks: Array<((res: T) => MaybePromise)> = [];
    private httpFailureCallbacks: Array<((res: Response, text: string) => MaybePromise)> = [];
    private networkErrorCallbacks: Array<((res: Error) => MaybePromise)> = [];
    private finallyCallbacks: Array<(() => MaybePromise)> = [];

    success(callback: (res: T) => MaybePromise, override: boolean = false) {
        if (override) {
            this.successCallbacks.length = 0;
        }
        this.successCallbacks.push(callback);
        return this;
    }

    failure(callback: (res: Error | Response, text?: string) => MaybePromise, override: boolean = false) {
        if (override) {
            this.httpFailureCallbacks.length = 0;
            this.networkErrorCallbacks.length = 0;
        }
        this.httpFailureCallbacks.push(callback);
        this.networkErrorCallbacks.push(callback);
        return this;
    }

    httpFailure(callback: (res: Response) => MaybePromise, override?: boolean): PromiseWrapper<T>;
    /** @deprecated Use without text instead */
    httpFailure(callback: (res: Response, text: string) => MaybePromise): PromiseWrapper<T>;
    httpFailure(callback: (res: Response, text: string) => MaybePromise, override: boolean = false) {
        if (override) {
            this.httpFailureCallbacks.length = 0;
        }
        this.httpFailureCallbacks.push(callback);
        return this;
    }

    networkFailure(callback: (res: Error) => MaybePromise, override: boolean = false) {
        if (override) {
            this.networkErrorCallbacks.length = 0;
        }
        this.networkErrorCallbacks.push(callback);
        return this;
    }

    finally(callback: () => MaybePromise, override: boolean = false) {
        if (override) {
            this.finallyCallbacks.length = 0;
        }
        this.finallyCallbacks.push(callback);
        return this;
    }
}


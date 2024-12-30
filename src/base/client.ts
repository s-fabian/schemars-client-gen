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
    fetch: self.fetch
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

class PromiseWrapper<T> implements PromiseLike<T> {
    promise: Promise<Result<T>>;
    end: (() => void) | null = null;
    private isSilent = false;
    private isDebug = false;

    silent() {
        this.isSilent = true;
        return this;
    }

    debug() {
        this.isDebug = true;
        return this;
    }

    failsafe(): Promise<void> {
        return new Promise<void>(r => {
            this.end = r;
        });
    }

    public then<TResult1 = T, TResult2 = never>(
        onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this.promise
            .then(res => res.success ? res.value : Promise.reject(res.response))
            .then(onFulfilled, onRejected);
    }

    constructor(promise: Promise<Result<T>>) {
        let start = Date.now();
        this.promise = promise;
        promise
            .then(
                async res => {
                    if (res.success) {
                        this.isDebug && console.info(res.value);

                        await (this.successCallback &&
                            this.successCallback(res.value));
                    } else {
                        const text = await res.response.text();

                        this.isDebug && console.warn(res.response, text);

                        await (this.networkFailureCallback &&
                            this.networkFailureCallback(res.response, text));

                        if (this.isSilent) return;

                        await (options.onHttpError && options.onHttpError(res.response, text))
                    }
                },
                async e => {
                    this.isDebug && console.error(e);
                    let error = e instanceof Error ? e : new Error(e);

                    await (this.networkErrorCallback &&
                        this.networkErrorCallback(error));

                    if (this.isSilent) return;

                    await (options.onNetworkError && options.onNetworkError(error));
                },
            )
            .catch(console.error)
            .then(() => {
                this.finallyCallback && this.finallyCallback();
                this.end && this.end();
            }, () => {
                this.finallyCallback && this.finallyCallback();
                this.end && this.end();
            });
    }

    private successCallback: ((res: T) => MaybePromise) | undefined = undefined;
    private networkFailureCallback:
        | ((res: Response, text: string) => MaybePromise)
        | undefined = undefined;
    private networkErrorCallback: ((res: Error) => MaybePromise) | undefined =
        undefined;
    private finallyCallback: (() => MaybePromise) | undefined = undefined;

    success(callback: (res: T) => MaybePromise) {
        this.successCallback = callback;
        return this;
    }

    failure(callback: (res: Error | Response, text?: string) => MaybePromise) {
        this.networkFailureCallback = callback;
        this.networkErrorCallback = callback;
        return this;
    }

    httpFailure(callback: (res: Response, text: string) => MaybePromise) {
        this.networkFailureCallback = callback;
        return this;
    }

    networkFailure(callback: (res: Error) => MaybePromise) {
        this.networkErrorCallback = callback;
        return this;
    }

    finally(callback: () => MaybePromise) {
        this.finallyCallback = callback;
        return this;
    }
}


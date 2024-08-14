import { z } from 'zod';

export namespace client {
    interface Options {
        baseUrl: string;
        globalInit: RequestInit;

        onHttpError?(res: Response, text: string): MaybePromise;

        onNetworkError?(res: Error): MaybePromise;
    }

    export const options: Options = {
        baseUrl: '',
        globalInit: {},
    };

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
    const ok = <T>(value: T) => ({ success: true, value } satisfies Ok<T>);
    const err = (response: Response) => ({ success: false, response } satisfies Err);

    const makeQuery = (params: Record<string, any>) =>
        '?' +
        new URLSearchParams(Object.fromEntries(
            Object.entries(params).filter(([_, v]) => v !== undefined),
        ));

    const hasId = (v: unknown): v is {id: number;} => {
        return v instanceof Object && 'id' in v && typeof v.id === 'number';
    };

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

        constructor (promise: Promise<Result<T>>) {
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

                            await (options.onHttpError &&
                                options.onHttpError(res.response, text));
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

    class SSE<Message> {
        public open = false;
        public sse: EventSource;
        private messageHandler: ((ev: MessageEvent) => void) | null = null;
        private closeHandler: ((ev: Event) => void) | null = null;

        constructor (
            private init: () => EventSource,
            private parse: (data: unknown) => Message,
        ) {
            this.sse = init();
            this.sse.onopen = () => this.open = true;
        }

        onMessage(handler: (this: SSE<Message>, data: Message) => void) {
            this.messageHandler = this.sse.onmessage = ev => {
                handler.call(this, this.parse(ev.data));
            };
        }

        onClose(handler: (this: SSE<Message>, reason: Event) => void) {
            this.closeHandler = this.sse.onerror = ev => {
                handler.call(this, ev);
            };
        }

        reconnect() {
            if (!this.open) {
                this.sse = this.init();
                this.sse.onmessage = this.messageHandler;
                this.sse.onerror = this.closeHandler;
            }
        }
    }

    class WebsocketWrapper<Client, Server> {
        public open = false;

        private disconnectReason: string | undefined;
        public reconnect = false;
        private reconnectTries = 0;

        private pending = new Map<number, (message: Server) => MaybePromise>();
        public ws: WebSocket | undefined;

        constructor (
            private websocketConstructor: () => WebSocket,
            private parseClient: (data: unknown) => Client,
            private parseServer: (data: unknown) => Server,
        ) {
            this.initWebsocket();
        }

        private initWebsocket() {
            if (this.ws) {
                this.ws.close();
            }

            this.open = false;

            const ws = (this.ws = this.websocketConstructor());

            ws.onopen = () => {
                // reconnected
                if (this.ws !== ws) return;

                this.open = true;
                this.disconnectReason = undefined;

                if (!this.reconnectTries) this.onConnect && this.onConnect();

                this.reconnectTries = 0;
            };

            ws.onerror = ev => {
                // reconnected
                if (this.ws !== ws) return;

                if (!this.open) {
                    if (this.reconnectTries) {
                        if (this.reconnect && this.reconnectTries++ < 5) {
                            this.initWebsocket();
                            return;
                        } else {
                            this.onDisconnect &&
                                this.onDisconnect(this.disconnectReason ?? '');
                        }
                    } else {
                        this.onFailure && this.onFailure(ev);
                    }
                }
            };

            ws.onclose = ev => {
                // reconnected
                if (this.ws !== ws) return;

                if (this.reconnect && this.reconnectTries++ < 5) {
                    this.disconnectReason = ev.reason;
                    this.initWebsocket();
                    return;
                }

                this.open = false;
                this.onDisconnect && this.onDisconnect(ev.reason ?? '');
            };

            ws.onmessage = ev => {
                // reconnected
                if (this.ws !== ws) return;

                if (typeof ev.data === 'string' && this.onMessage) {
                    const data: Server = this.parseServer(JSON.parse(ev.data));

                    if (hasId(data)) {
                        const resolve = this.pending.get(data.id);
                        if (resolve) {
                            this.pending.delete(data.id);
                            resolve(data);
                            return;
                        }
                    }

                    this.onMessage(data);
                }
            };
        }

        private onConnect: (() => MaybePromise) | undefined = undefined;
        private onFailure: ((ev: Event) => MaybePromise) | undefined = undefined;
        private onDisconnect: ((reason: string) => MaybePromise) | undefined = undefined;
        private onMessage: ((message: Server) => MaybePromise) | undefined = undefined;

        send(message: Client & {id?: number;}, resolve: true): Promise<Server>;
        send(message: Client): void;
        send(message: Client, resolve?: true) {
            if (!this.open || !this.ws) {
                if (resolve) {
                    return Promise.reject();
                } else {
                    return;
                }
            }

            let id: number | undefined;
            if (resolve) {
                id = Date.now();
                (message as Client & {id?: number;}).id = id;
            }

            const parsed = this.parseClient(message);
            const converted = JSON.stringify(parsed);

            this.ws.send(converted);

            if (!resolve) return;

            let resolver: (v: Server) => MaybePromise;
            const promise = new Promise<Server>((r, e) => {
                resolver = r;
                setTimeout(() => {
                    this.pending.delete(id!);
                    e('Timeout!');
                }, 5000);
            });
            this.pending.set(id!, resolver!);
            return promise;
        }

        autoReconnect() {
            this.reconnect = true;
            return this;
        }

        connect(callback: () => MaybePromise) {
            this.onConnect = callback;
            return this;
        }

        failure(callback: (ev: Event) => MaybePromise) {
            this.onFailure = callback;
            return this;
        }

        disconnect(callback: (reason: string) => MaybePromise) {
            this.onDisconnect = callback;
            return this;
        }

        message(callback: (message: Server) => MaybePromise) {
            this.onMessage = callback;
            return this;
        }

        destroy() {
            this.ws?.close();
            // stops all event handlers
            this.open = false;
            this.ws = undefined;
        }
    }

    export namespace main {
        const getSseParamsSchema = z.object({
            age: z.number().int().min(0),
            name: z.string(),
        });
        export type GetSseParams = z.input<typeof getSseParamsSchema>;

        const getSseMsg = z.object({
            data: z.number().int().min(0).array(),
            info: z.string(),
        });
        export type GetSseMsg = z.output<typeof getSseMsg>;

        export type GetSseSSE = SSE<GetSseMsg>;

        export function getSse(params: GetSseParams): GetSseSSE {
            const url = (!options.baseUrl || options.baseUrl.startsWith('/'))
                ? `//${location.host}${options.baseUrl}`
                : ('//' +
                    options.baseUrl.replace(/^https:\/\//, '').replace(/^http:\/\//, ''));

            return new SSE(
                () =>
                    new EventSource(
                        `${url}/api/sse${makeQuery(getSseParamsSchema.parse(params))}`,
                    ),
                data => getSseMsg.parse(data),
            );
        }
    }
}

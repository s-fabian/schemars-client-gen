import { z } from 'zod';

export namespace client {
    interface Options {
        baseUrl: string;
        globalInit: RequestInit;

        onHttpError?(res: Response): MaybePromise;

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

    const makeQuery = (params: Record<string, any>) => '?' + new URLSearchParams(params);

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

                            await (this.success_callback &&
                                this.success_callback(res.value));
                        } else {
                            const text = await res.response.text();

                            this.isDebug && console.warn(res.response, text);

                            await (this.network_failure_callback &&
                                this.network_failure_callback(res.response, text));

                            if (this.isSilent) return;

                            await (options.onHttpError &&
                                options.onHttpError(res.response));
                        }
                    },
                    async e => {
                        this.isDebug && console.error(e);
                        let error = e instanceof Error ? e : new Error(e);

                        await (this.network_error_callback &&
                            this.network_error_callback(error));

                        if (this.isSilent) return;

                        await (options.onNetworkError && options.onNetworkError(error));
                    },
                )
                .catch(console.error)
                .then(() => {
                    this.finally_callback && this.finally_callback();
                    this.end && this.end();
                }, () => {
                    this.finally_callback && this.finally_callback();
                    this.end && this.end();
                });
        }

        private success_callback: ((res: T) => MaybePromise) | undefined = undefined;
        private network_failure_callback:
            | ((res: Response, text: string) => MaybePromise)
            | undefined = undefined;
        private network_error_callback: ((res: Error) => MaybePromise) | undefined =
            undefined;
        private finally_callback: (() => MaybePromise) | undefined = undefined;

        success(callback: (res: T) => MaybePromise) {
            this.success_callback = callback;
            return this;
        }

        failure(callback: (res: Error | Response, text?: string) => MaybePromise) {
            this.network_failure_callback = callback;
            this.network_error_callback = callback;
            return this;
        }

        http_failure(callback: (res: Response, text: string) => MaybePromise) {
            this.network_failure_callback = callback;
            return this;
        }

        network_failure(callback: (res: Error) => MaybePromise) {
            this.network_error_callback = callback;
            return this;
        }

        finally(callback: () => MaybePromise) {
            this.finally_callback = callback;
            return this;
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

    export namespace admin {
        const postInviteReqSchema = z.object({
            email: z.string().email().min(1).max(250),
            name: z.string().min(1).max(250),
        });
        export type PostInviteReq = z.input<typeof postInviteReqSchema>;

        export function postInvite(
            req: PostInviteReq,
            init: RequestInit = {},
        ): PromiseWrapper<Response> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/admin/invite',
                    {
                        method: 'POST',
                        body: JSON.stringify(postInviteReqSchema.parse(req)),
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                        headers: jsonContentTypeHeader(
                            init.headers as RepresentsHeader,
                            options.globalInit.headers as RepresentsHeader,
                        ),
                    },
                ).then(res => res.ok ? ok(res) : err(res)),
            );
        }

        const postBoardAccessReqSchema = z.object({
            boardId: z.string().uuid(),
            email: z.string().email().min(1).max(250),
        });
        export type PostBoardAccessReq = z.input<typeof postBoardAccessReqSchema>;

        export function postBoardAccess(
            req: PostBoardAccessReq,
            init: RequestInit = {},
        ): PromiseWrapper<Response> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/admin/board/access',
                    {
                        method: 'POST',
                        body: JSON.stringify(postBoardAccessReqSchema.parse(req)),
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                        headers: jsonContentTypeHeader(
                            init.headers as RepresentsHeader,
                            options.globalInit.headers as RepresentsHeader,
                        ),
                    },
                ).then(res => res.ok ? ok(res) : err(res)),
            );
        }

        const deleteBoardAccessParamsSchema = z.object({
            board_id: z.string().uuid(),
            user_id: z.string().uuid(),
        });
        export type DeleteBoardAccessParams = z.input<
            typeof deleteBoardAccessParamsSchema
        >;

        export function deleteBoardAccess(
            params: DeleteBoardAccessParams,
            init: RequestInit = {},
        ): PromiseWrapper<Response> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/admin/board/access' +
                        makeQuery(deleteBoardAccessParamsSchema.parse(params)),
                    {
                        method: 'DELETE',
                        body: null,
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                    },
                ).then(res => res.ok ? ok(res) : err(res)),
            );
        }
    }

    export namespace login {
        const postSessionIdReqSchema = z.object({
            email: z.string(),
            password: z.string(),
        });
        export type PostSessionIdReq = z.input<typeof postSessionIdReqSchema>;

        const postSessionIdResSchema = z.object({ sessionId: z.string().uuid() });
        export type PostSessionIdRes = z.output<typeof postSessionIdResSchema>;

        export function postSessionId(
            req: PostSessionIdReq,
            init: RequestInit = {},
        ): PromiseWrapper<PostSessionIdRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/login/session-id',
                    {
                        method: 'POST',
                        body: JSON.stringify(postSessionIdReqSchema.parse(req)),
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                        headers: jsonContentTypeHeader(
                            init.headers as RepresentsHeader,
                            options.globalInit.headers as RepresentsHeader,
                        ),
                    },
                ).then(res =>
                    res.ok ? res.json().then(postSessionIdResSchema.parse).then(ok)
                        : err(res)
                ),
            );
        }

        export function deleteSessionId(
            init: RequestInit = {},
        ): PromiseWrapper<Response> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/login/session-id',
                    {
                        method: 'DELETE',
                        body: null,
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                    },
                ).then(res => res.ok ? ok(res) : err(res)),
            );
        }

        const putPasswordReqSchema = z.object({
            email: z.string(),
            password: z.string(),
        });
        export type PutPasswordReq = z.input<typeof putPasswordReqSchema>;

        const putPasswordResSchema = z.object({ pendingId: z.string().uuid() });
        export type PutPasswordRes = z.output<typeof putPasswordResSchema>;

        export function putPassword(
            req: PutPasswordReq,
            init: RequestInit = {},
        ): PromiseWrapper<PutPasswordRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/login/password',
                    {
                        method: 'PUT',
                        body: JSON.stringify(putPasswordReqSchema.parse(req)),
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                        headers: jsonContentTypeHeader(
                            init.headers as RepresentsHeader,
                            options.globalInit.headers as RepresentsHeader,
                        ),
                    },
                ).then(res =>
                    res.ok ? res.json().then(putPasswordResSchema.parse).then(ok)
                        : err(res)
                ),
            );
        }

        const putPendingPasswordReqSchema = z.object({
            code: z.string(),
            pendingId: z.string().uuid(),
        });
        export type PutPendingPasswordReq = z.input<typeof putPendingPasswordReqSchema>;

        const putPendingPasswordResSchema = z.object({ sessionId: z.string().uuid() });
        export type PutPendingPasswordRes = z.output<typeof putPendingPasswordResSchema>;

        export function putPendingPassword(
            req: PutPendingPasswordReq,
            init: RequestInit = {},
        ): PromiseWrapper<PutPendingPasswordRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/login/pending/password',
                    {
                        method: 'PUT',
                        body: JSON.stringify(putPendingPasswordReqSchema.parse(req)),
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                        headers: jsonContentTypeHeader(
                            init.headers as RepresentsHeader,
                            options.globalInit.headers as RepresentsHeader,
                        ),
                    },
                ).then(res =>
                    res.ok ? res.json().then(putPendingPasswordResSchema.parse).then(ok)
                        : err(res)
                ),
            );
        }
    }

    export namespace user {
        const putWorkingHourReqSchema = z.object({
            hourId: z.string().uuid().nullable().optional(),
            info: z.string().nullable().optional(),
            minutes: z.number().int().min(0).nullable().optional(),
            start: z.date(),
            taskId: z.string().uuid().nullable().optional(),
        });
        export type PutWorkingHourReq = z.input<typeof putWorkingHourReqSchema>;

        const putWorkingHourResSchema = z.object({ hourId: z.string().uuid() });
        export type PutWorkingHourRes = z.output<typeof putWorkingHourResSchema>;

        export function putWorkingHour(
            req: PutWorkingHourReq,
            init: RequestInit = {},
        ): PromiseWrapper<PutWorkingHourRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/user/working-hour',
                    {
                        method: 'PUT',
                        body: JSON.stringify(putWorkingHourReqSchema.parse(req)),
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                        headers: jsonContentTypeHeader(
                            init.headers as RepresentsHeader,
                            options.globalInit.headers as RepresentsHeader,
                        ),
                    },
                ).then(res =>
                    res.ok ? res.json().then(putWorkingHourResSchema.parse).then(ok)
                        : err(res)
                ),
            );
        }

        const postBoardReqSchema = z.object({
            emoji: z.string().max(4).nullable().optional(),
            name: z.string().min(1).max(250),
        });
        export type PostBoardReq = z.input<typeof postBoardReqSchema>;

        const postBoardResSchema = z.object({ boardId: z.string().uuid() });
        export type PostBoardRes = z.output<typeof postBoardResSchema>;

        export function postBoard(
            req: PostBoardReq,
            init: RequestInit = {},
        ): PromiseWrapper<PostBoardRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/user/board',
                    {
                        method: 'POST',
                        body: JSON.stringify(postBoardReqSchema.parse(req)),
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                        headers: jsonContentTypeHeader(
                            init.headers as RepresentsHeader,
                            options.globalInit.headers as RepresentsHeader,
                        ),
                    },
                ).then(res =>
                    res.ok ? res.json().then(postBoardResSchema.parse).then(ok) : err(res)
                ),
            );
        }

        const patchUserReqSchema = z.object({
            color: z.string().regex(new RegExp('^#?([0-9a-fA-F]{3}){1,2}$')),
            nickname: z.string().min(1).max(250),
        });
        export type PatchUserReq = z.input<typeof patchUserReqSchema>;

        export function patchUser(
            req: PatchUserReq,
            init: RequestInit = {},
        ): PromiseWrapper<Response> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/user/user',
                    {
                        method: 'PATCH',
                        body: JSON.stringify(patchUserReqSchema.parse(req)),
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                        headers: jsonContentTypeHeader(
                            init.headers as RepresentsHeader,
                            options.globalInit.headers as RepresentsHeader,
                        ),
                    },
                ).then(res => res.ok ? ok(res) : err(res)),
            );
        }

        const deleteWorkingHourParamsSchema = z.object({ hour_id: z.string().uuid() });
        export type DeleteWorkingHourParams = z.input<
            typeof deleteWorkingHourParamsSchema
        >;

        export function deleteWorkingHour(
            params: DeleteWorkingHourParams,
            init: RequestInit = {},
        ): PromiseWrapper<Response> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/user/working-hour' +
                        makeQuery(deleteWorkingHourParamsSchema.parse(params)),
                    {
                        method: 'DELETE',
                        body: null,
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                    },
                ).then(res => res.ok ? ok(res) : err(res)),
            );
        }

        const getUserResSchema = z.object({
            admin: z.boolean(),
            color: z.string().regex(new RegExp('^#?([0-9a-fA-F]{3}){1,2}$')),
            email: z.string(),
            name: z.string(),
            role: z.enum(['adminMan', 'employeeMan']),
            userId: z.string().uuid(),
        });
        export type GetUserRes = z.output<typeof getUserResSchema>;

        export function getUser(init: RequestInit = {}): PromiseWrapper<GetUserRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/user/user',
                    {
                        method: 'GET',
                        body: null,
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                    },
                ).then(res =>
                    res.ok ? res.json().then(getUserResSchema.parse).then(ok) : err(res)
                ),
            );
        }

        const getWorkingHoursParamsSchema = z.object({ year: z.number().int() });
        export type GetWorkingHoursParams = z.input<typeof getWorkingHoursParamsSchema>;

        const getWorkingHoursResSchema = z.object({
            workingHours: z.object({
                hourId: z.string().uuid(),
                info: z.string().nullable().optional(),
                minutes: z.number().int().min(0).nullable().optional(),
                start: z.coerce.date(),
                task: z.object({
                    boardId: z.string().uuid(),
                    columnId: z.string().uuid(),
                    description: z.string().nullable().optional(),
                    name: z.string(),
                    taskId: z.string().uuid(),
                }).nullable().optional(),
            }).array(),
        });
        export type GetWorkingHoursRes = z.output<typeof getWorkingHoursResSchema>;

        export function getWorkingHours(
            params: GetWorkingHoursParams,
            init: RequestInit = {},
        ): PromiseWrapper<GetWorkingHoursRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/user/working-hours' +
                        makeQuery(getWorkingHoursParamsSchema.parse(params)),
                    {
                        method: 'GET',
                        body: null,
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                    },
                ).then(res =>
                    res.ok ? res.json().then(getWorkingHoursResSchema.parse).then(ok)
                        : err(res)
                ),
            );
        }

        const getTaskWorkingHoursParamsSchema = z.object({ taskId: z.string().uuid() });
        export type GetTaskWorkingHoursParams = z.input<
            typeof getTaskWorkingHoursParamsSchema
        >;

        const getTaskWorkingHoursResSchema = z.object({
            workingHours: z.object({
                hourId: z.string().uuid(),
                info: z.string().nullable().optional(),
                minutes: z.number().int().min(0).nullable().optional(),
                start: z.coerce.date(),
            }).array(),
        });
        export type GetTaskWorkingHoursRes = z.output<
            typeof getTaskWorkingHoursResSchema
        >;

        export function getTaskWorkingHours(
            params: GetTaskWorkingHoursParams,
            init: RequestInit = {},
        ): PromiseWrapper<GetTaskWorkingHoursRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/user/task/working-hours' +
                        makeQuery(getTaskWorkingHoursParamsSchema.parse(params)),
                    {
                        method: 'GET',
                        body: null,
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                    },
                ).then(res =>
                    res.ok ? res.json().then(getTaskWorkingHoursResSchema.parse).then(ok)
                        : err(res)
                ),
            );
        }

        const getBoardsResSchema = z.object({
            boards: z.object({
                boardId: z.string().uuid(),
                emoji: z.string(),
                name: z.string(),
            }).array(),
        });
        export type GetBoardsRes = z.output<typeof getBoardsResSchema>;

        export function getBoards(init: RequestInit = {}): PromiseWrapper<GetBoardsRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/user/boards',
                    {
                        method: 'GET',
                        body: null,
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                    },
                ).then(res =>
                    res.ok ? res.json().then(getBoardsResSchema.parse).then(ok) : err(res)
                ),
            );
        }

        const getBoardParamsSchema = z.object({ boardId: z.string().uuid() });
        export type GetBoardParams = z.input<typeof getBoardParamsSchema>;

        const getBoardResSchema = z.object({
            columns: z.object({
                info: z.object({
                    columnId: z.string().uuid(),
                    emoji: z.string().nullable().optional(),
                    limitDays: z.number().int().min(0).nullable().optional(),
                    name: z.string(),
                }),
                tasks: z.object({
                    assignedId: z.string().uuid().nullable().optional(),
                    info: z.object({
                        assignedUserId: z.string().uuid().nullable().optional(),
                        columnId: z.string().uuid(),
                        description: z.string().nullable().optional(),
                        lastChanged: z.coerce.date(),
                        name: z.string(),
                        taskId: z.string().uuid(),
                    }),
                    workingHours: z.object({
                        hourId: z.string().uuid(),
                        info: z.string().nullable().optional(),
                        minutes: z.number().int().min(0).nullable().optional(),
                        start: z.coerce.date(),
                        taskId: z.string().uuid(),
                        userId: z.string().uuid(),
                    }).array(),
                }).array(),
                workingMinutesTotal: z.number().int().min(0),
            }).array(),
            info: z.object({
                boardId: z.string().uuid(),
                emoji: z.string().nullable().optional(),
                name: z.string(),
            }),
            messages: z.object({
                authorId: z.string().uuid(),
                createdAt: z.coerce.date(),
                editedAt: z.coerce.date().nullable().optional(),
                messageId: z.string().uuid(),
                text: z.string(),
            }).array(),
            messagesTotal: z.number().int(),
            userAccess: z.record(z.object({
                admin: z.boolean(),
                color: z.string().regex(new RegExp('^#?([0-9a-fA-F]{3}){1,2}$')),
                email: z.string(),
                name: z.string(),
                nickname: z.string().nullable().optional(),
                role: z.enum(['adminMan', 'employeeMan']),
                userId: z.string().uuid(),
            })),
        });
        export type GetBoardRes = z.output<typeof getBoardResSchema>;

        export function getBoard(
            params: GetBoardParams,
            init: RequestInit = {},
        ): PromiseWrapper<GetBoardRes> {
            return new PromiseWrapper(
                fetch(
                    options.baseUrl + '/api/user/board' +
                        makeQuery(getBoardParamsSchema.parse(params)),
                    {
                        method: 'GET',
                        body: null,
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,
                    },
                ).then(res =>
                    res.ok ? res.json().then(getBoardResSchema.parse).then(ok) : err(res)
                ),
            );
        }

        const getBoardEventsParamsSchema = z.object({ boardId: z.string().uuid() });
        export type GetBoardEventsParams = z.input<typeof getBoardEventsParamsSchema>;

        const getBoardEventsClientMsgSchema = z.object({
            data: z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('createMessage'), message: z.string() }),
                z.object({
                    kind: z.literal('updateMessage'),
                    message: z.string(),
                    messageId: z.string().uuid(),
                }),
                z.object({
                    board: z.object({
                        emoji: z.string().max(4).nullable().optional(),
                        name: z.string().min(1).max(250),
                    }),
                    kind: z.literal('updateBoard'),
                }),
                z.object({
                    column: z.object({
                        emoji: z.string().max(4).nullable().optional(),
                        limitDays: z.number().int().min(0).nullable().optional(),
                        name: z.string().min(1).max(250),
                    }),
                    kind: z.literal('createColumn'),
                }),
                z.object({
                    column: z.object({
                        columnId: z.string().uuid(),
                        emoji: z.string().max(4).nullable().optional(),
                        limitDays: z.number().int().min(0).nullable().optional(),
                        name: z.string().min(1).max(250),
                    }),
                    kind: z.literal('updateColumn'),
                }),
                z.object({
                    columnId: z.string().uuid(),
                    kind: z.literal('deleteColumn'),
                }),
                z.object({
                    columnId: z.string().uuid(),
                    index: z.number().int().min(0),
                    kind: z.literal('moveColumn'),
                }),
                z.object({
                    kind: z.literal('createTask'),
                    task: z.object({
                        assignedUserId: z.string().uuid().nullable().optional(),
                        columnId: z.string().uuid(),
                        description: z.string().nullable().optional(),
                        name: z.string().min(1).max(250),
                    }),
                }),
                z.object({
                    kind: z.literal('updateTask'),
                    task: z.object({
                        assignedUserId: z.string().uuid().nullable().optional(),
                        description: z.string().nullable().optional(),
                        name: z.string().min(1).max(250),
                        taskId: z.string().uuid(),
                    }),
                }),
                z.object({ kind: z.literal('deleteTask'), taskId: z.string().uuid() }),
                z.object({
                    columnId: z.string().uuid(),
                    index: z.number().int().min(0),
                    kind: z.literal('moveTask'),
                    taskId: z.string().uuid(),
                }),
                z.object({
                    cursor: z.object({
                        end: z.number().int().min(0).nullable().optional(),
                        start: z.number().int().min(0).nullable().optional(),
                    }),
                    description: z.string().nullable().optional(),
                    kind: z.literal('descriptionUpdate'),
                    taskId: z.string().uuid(),
                    updates: z.object({
                        count: z.number().int().min(0).nullable().optional(),
                        start: z.number().int().min(0),
                        string: z.string().nullable().optional(),
                    }).array(),
                }),
                z.object({
                    kind: z.literal('createWorkingHour'),
                    workingHour: z.object({
                        info: z.string().min(1).max(250).nullable().optional(),
                        minutes: z.number().int().min(0).nullable().optional(),
                        start: z.date(),
                        taskId: z.string().uuid(),
                    }),
                }),
                z.object({
                    kind: z.literal('updateWorkingHour'),
                    workingHour: z.object({
                        hourId: z.string().uuid(),
                        info: z.string().min(1).max(250).nullable().optional(),
                        minutes: z.number().int().min(0).nullable().optional(),
                        start: z.date(),
                    }),
                }),
                z.object({
                    hourId: z.string().uuid(),
                    kind: z.literal('deleteWorkingHour'),
                }),
            ]),
            id: z.number().int().min(0).nullable().optional(),
        });
        export type GetBoardEventsClientMsg = z.output<
            typeof getBoardEventsClientMsgSchema
        >;
        const getBoardEventsServerMsgSchema = z.object({
            data: z.discriminatedUnion('kind', [
                z.object({
                    author: z.object({
                        admin: z.boolean(),
                        color: z.string().regex(new RegExp('^#?([0-9a-fA-F]{3}){1,2}$')),
                        email: z.string(),
                        name: z.string(),
                        nickname: z.string().nullable().optional(),
                        role: z.enum(['adminMan', 'employeeMan']),
                        userId: z.string().uuid(),
                    }),
                    createdAt: z.coerce.date(),
                    kind: z.literal('createMessage'),
                    messageId: z.string().uuid(),
                    text: z.string(),
                }),
                z.object({
                    editedAt: z.coerce.date(),
                    kind: z.literal('updateMessage'),
                    messageId: z.string().uuid(),
                    text: z.string(),
                }),
                z.object({
                    board: z.object({
                        emoji: z.string().max(4).nullable().optional(),
                        name: z.string().min(1).max(250),
                    }),
                    kind: z.literal('updateBoard'),
                }),
                z.object({
                    column: z.object({
                        columnId: z.string().uuid(),
                        emoji: z.string().max(4).nullable().optional(),
                        limitDays: z.number().int().min(0).nullable().optional(),
                        name: z.string().min(1).max(250),
                    }),
                    kind: z.literal('createColumn'),
                }),
                z.object({
                    column: z.object({
                        columnId: z.string().uuid(),
                        emoji: z.string().max(4).nullable().optional(),
                        limitDays: z.number().int().min(0).nullable().optional(),
                        name: z.string().min(1).max(250),
                    }),
                    kind: z.literal('updateColumn'),
                }),
                z.object({
                    columnId: z.string().uuid(),
                    kind: z.literal('deleteColumn'),
                }),
                z.object({
                    columnId: z.string().uuid(),
                    index: z.number().int().min(0),
                    kind: z.literal('moveColumn'),
                }),
                z.object({
                    assigned: z.object({
                        admin: z.boolean(),
                        color: z.string().regex(new RegExp('^#?([0-9a-fA-F]{3}){1,2}$')),
                        email: z.string(),
                        name: z.string(),
                        nickname: z.string().nullable().optional(),
                        role: z.enum(['adminMan', 'employeeMan']),
                        userId: z.string().uuid(),
                    }).nullable().optional(),
                    kind: z.literal('createTask'),
                    task: z.object({
                        assignedUserId: z.string().uuid().nullable().optional(),
                        columnId: z.string().uuid(),
                        description: z.string().nullable().optional(),
                        lastChanged: z.coerce.date(),
                        name: z.string().min(1).max(250),
                        taskId: z.string().uuid(),
                    }),
                }),
                z.object({
                    assigned: z.object({
                        admin: z.boolean(),
                        color: z.string().regex(new RegExp('^#?([0-9a-fA-F]{3}){1,2}$')),
                        email: z.string(),
                        name: z.string(),
                        nickname: z.string().nullable().optional(),
                        role: z.enum(['adminMan', 'employeeMan']),
                        userId: z.string().uuid(),
                    }).nullable().optional(),
                    kind: z.literal('updateTask'),
                    task: z.object({
                        assignedUserId: z.string().uuid().nullable().optional(),
                        columnId: z.string().uuid(),
                        description: z.string().nullable().optional(),
                        lastChanged: z.coerce.date(),
                        name: z.string().min(1).max(250),
                        taskId: z.string().uuid(),
                    }),
                }),
                z.object({
                    columnId: z.string().uuid(),
                    kind: z.literal('deleteTask'),
                    taskId: z.string().uuid(),
                }),
                z.object({
                    columnId: z.string().uuid(),
                    index: z.number().int().min(0),
                    kind: z.literal('moveTask'),
                    pastColumnId: z.string().uuid(),
                    taskId: z.string().uuid(),
                }),
                z.object({
                    columnId: z.string().uuid(),
                    cursor: z.object({
                        end: z.number().int().min(0).nullable().optional(),
                        start: z.number().int().min(0).nullable().optional(),
                    }),
                    description: z.string().nullable().optional(),
                    kind: z.literal('descriptionUpdate'),
                    taskId: z.string().uuid(),
                    updates: z.object({
                        count: z.number().int().min(0).nullable().optional(),
                        start: z.number().int().min(0),
                        string: z.string().nullable().optional(),
                    }).array(),
                }),
                z.object({
                    kind: z.literal('createWorkingHour'),
                    workingHour: z.object({
                        columnId: z.string().uuid(),
                        hourId: z.string().uuid(),
                        info: z.string().nullable().optional(),
                        minutes: z.number().int().min(0).nullable().optional(),
                        start: z.coerce.date(),
                        taskId: z.string().uuid(),
                    }),
                }),
                z.object({
                    kind: z.literal('updateWorkingHour'),
                    workingHour: z.object({
                        columnId: z.string().uuid(),
                        hourId: z.string().uuid(),
                        info: z.string().nullable().optional(),
                        minutes: z.number().int().min(0).nullable().optional(),
                        start: z.coerce.date(),
                        taskId: z.string().uuid(),
                    }),
                }),
                z.object({
                    columnId: z.string().uuid(),
                    hourId: z.string().uuid(),
                    kind: z.literal('deleteWorkingHour'),
                    minutes: z.number().int().min(0).nullable().optional(),
                    taskId: z.string().uuid(),
                }),
                z.object({
                    info: z.string().nullable().optional(),
                    kind: z.literal('error'),
                    status: z.number().int().min(0),
                }),
            ]),
            id: z.number().int().min(0).nullable().optional(),
            user: z.object({
                admin: z.boolean(),
                color: z.string().regex(new RegExp('^#?([0-9a-fA-F]{3}){1,2}$')),
                email: z.string(),
                name: z.string(),
                nickname: z.string().nullable().optional(),
                role: z.enum(['adminMan', 'employeeMan']),
                userId: z.string().uuid(),
            }),
            when: z.coerce.date(),
        });
        export type GetBoardEventsServerMsg = z.output<
            typeof getBoardEventsServerMsgSchema
        >;
        export type GetBoardEventsWebsocket = WebsocketWrapper<
            GetBoardEventsClientMsg,
            GetBoardEventsServerMsg
        >;

        export function getBoardEvents(
            params: GetBoardEventsParams,
        ): GetBoardEventsWebsocket {
            const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';

            const wsBaseUrl = (!options.baseUrl || options.baseUrl.startsWith('/'))
                ? `${protocol}${location.host}${options.baseUrl}`
                : (protocol +
                    options.baseUrl.replace(/^https:\/\//, '').replace(/^http:\/\//, ''));

            return new WebsocketWrapper(
                () =>
                    new WebSocket(
                        `${wsBaseUrl}/api/user/board/events${
                            makeQuery(getBoardEventsParamsSchema.parse(params))
                        }`,
                    ),
                data => getBoardEventsClientMsgSchema.parse(data),
                data => getBoardEventsServerMsgSchema.parse(data),
            );
        }
    }
}
